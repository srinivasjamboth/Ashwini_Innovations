'use client';

// ============================================================
// Carousel card editor (Part 1 of the media-card-carousel build).
//
// The panel the builder shows when the Header dropdown is set to
// "Carousel". It owns three things, in Meta's order of importance:
//
//   1. SHARED settings — media format, "cards have text", and the
//      button layout apply to every card at once, so a card that
//      violates Meta's "all cards identical" rule cannot be built.
//   2. The CARD STRIP — add (2–10), drag/keyboard reorder, duplicate,
//      delete (never below 2), with a red dot on any incomplete card.
//   3. The ACTIVE CARD editor — media upload (browse or drag & drop,
//      concurrency 3, per-file retry), card text with variables, and
//      one field set per shared button.
//
// All pure logic (limits, issues, layout application) lives in
// `@/lib/whatsapp/carousel` — the same module the server validates
// with — so client and server can never drift.
//
// The panel is fully controlled: it receives the card document and an
// UPDATER function, never a snapshot. Concurrent card-media uploads
// then compose through React's functional setState instead of racing
// on a stale closure.
// ============================================================

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertCircle,
  Copy,
  GripVertical,
  Loader2,
  Play,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MEDIA_MAX_BYTES_BY_KIND,
  uploadAccountMedia,
} from '@/lib/storage/upload-media';
import { MEDIA_HEADER_SPECS } from '@/lib/whatsapp/media-header-types';
import {
  applyButtonLayout,
  CAROUSEL_LIMITS,
  emptyCarouselCard,
  isCarouselCardComplete,
  type CarouselIssue,
} from '@/lib/whatsapp/carousel';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import type {
  CarouselButtonKind,
  CarouselCard,
  CarouselMediaFormat,
  CarouselTemplateData,
} from '@/types';

// Meta accepts up to 5 MB images and 16 MB videos for template media;
// `MEDIA_MAX_BYTES_BY_KIND` already encodes the conservative bucket-side
// cap for both kinds, so the upload path just reuses it.
const UPLOAD_CONCURRENCY = 3;

type CarouselUpdater = (
  next: (data: CarouselTemplateData) => CarouselTemplateData,
) => void;

interface CarouselEditorProps {
  data: CarouselTemplateData;
  /** Functional updater — safe across parallel uploads (see header). */
  onChange: CarouselUpdater;
  activeCard: number;
  onActiveCardChange: (index: number) => void;
  /** Template-level + per-card problems; the summary lists them. */
  issues: CarouselIssue[];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** New card buttons always mirror the shared layout. */
function buttonsForLayout(
  layout: CarouselTemplateData['button_layout'],
): CarouselCard['buttons'] {
  return layout.map((item) => ({ type: item.type, text: '' }));
}

/** Resize a card's sample list to exactly its variable count, keeping filled ones. */
function syncTextExamples(card: CarouselCard): CarouselCard {
  const vars = extractVariableIndices(card.text ?? '');
  const next = (card.text_examples ?? []).slice(0, vars.length);
  while (next.length < vars.length) next.push('');
  return { ...card, text_examples: next };
}

const BUTTON_KIND_LABEL_KEY: Record<CarouselButtonKind, string> = {
  QUICK_REPLY: 'btnQuickReply',
  URL: 'btnUrl',
  PHONE_NUMBER: 'btnPhone',
};

export function CarouselEditor({
  data,
  onChange,
  activeCard,
  onActiveCardChange,
  issues,
}: CarouselEditorProps) {
  const t = useTranslations('Settings.templates');

  const cardCount = data.cards.length;
  const safeActive = Math.min(Math.max(activeCard, 0), cardCount - 1);
  const activeCardData = data.cards[safeActive];

  // ── announcements (add / remove) for screen readers ──────────────
  const [announcement, setAnnouncement] = React.useState('');

  // ── per-card upload state ──────────────────────────────────────────
  const [uploading, setUploading] = React.useState<Record<number, boolean>>({});
  const [failedFiles, setFailedFiles] = React.useState<Record<number, File>>({});
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const mutate = onChange;

  const updateCard = React.useCallback(
    (index: number, patch: (card: CarouselCard) => CarouselCard) => {
      onChange((d) => ({
        ...d,
        cards: d.cards.map((c, i) => (i === index ? patch(c) : c)),
      }));
    },
    [onChange],
  );

  // ── shared settings ────────────────────────────────────────────────

  function switchMediaFormat(format: CarouselMediaFormat) {
    if (data.media_format === format) return;
    mutate((d) => ({
      ...d,
      media_format: format,
      // Meta requires every card to share one format — a stale-format
      // asset can only be re-uploaded, so clear them all up-front
      // rather than let ten red dots confuse the fix.
      cards: d.cards.map((c) => ({
        ...c,
        media_url: null,
        media_handle: null,
        media_filename: null,
        media_size: null,
      })),
    }));
    setFailedFiles({});
    toast.info(t('carouselMediaSwitchCleared'));
  }

  function setButtonLayout(kinds: CarouselButtonKind[]) {
    // Meta's non-interleaving rule made deterministic: quick replies
    // always sort before URL / phone, so an illegal layout is
    // unreachable rather than merely warned about.
    const sorted = [...kinds].sort(
      (a, b) => (a === 'QUICK_REPLY' ? 0 : 1) - (b === 'QUICK_REPLY' ? 0 : 1),
    );
    mutate((d) => applyButtonLayout(d, sorted));
  }

  const layoutKinds = data.button_layout.map((b) => b.type);

  // ── card strip operations ──────────────────────────────────────────

  function addCard() {
    if (cardCount >= CAROUSEL_LIMITS.maxCards) return;
    mutate((d) => ({
      ...d,
      cards: [
        ...d.cards,
        { ...emptyCarouselCard(), buttons: buttonsForLayout(d.button_layout) },
      ],
    }));
    onActiveCardChange(cardCount);
    setAnnouncement(t('carouselAnnounceAdded', { n: cardCount + 1 }));
  }

  function duplicateCard(index: number) {
    if (cardCount >= CAROUSEL_LIMITS.maxCards) return;
    mutate((d) => {
      const source = d.cards[index];
      if (!source) return d;
      const copy: CarouselCard = {
        ...source,
        // The Meta handle refers to an already-uploaded asset — reuse
        // it; re-uploading the identical file would waste a call.
        buttons: source.buttons.map((b) => ({ ...b })),
        text_examples: [...(source.text_examples ?? [])],
      };
      const cards = [...d.cards];
      cards.splice(index + 1, 0, copy);
      return { ...d, cards };
    });
    onActiveCardChange(index + 1);
    setAnnouncement(t('carouselAnnounceAdded', { n: index + 2 }));
  }

  function deleteCard(index: number) {
    if (cardCount <= CAROUSEL_LIMITS.minCards) return;
    mutate((d) => ({ ...d, cards: d.cards.filter((_, i) => i !== index) }));
    onActiveCardChange(Math.min(index, cardCount - 2));
    setAnnouncement(t('carouselAnnounceRemoved'));
    setFailedFiles((prev) => {
      const next: Record<number, File> = {};
      for (const [k, v] of Object.entries(prev)) {
        const i = Number(k);
        if (i < index) next[i] = v;
        else if (i > index) next[i - 1] = v;
      }
      return next;
    });
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = Number(active.id);
    const to = Number(over.id);
    mutate((d) => ({ ...d, cards: arrayMove(d.cards, from, to) }));
    onActiveCardChange(to);
  }

  // ── media upload ───────────────────────────────────────────────────

  async function uploadFiles(files: File[], startIndex: number) {
    const format = data.media_format;
    const spec = MEDIA_HEADER_SPECS[format];
    const maxBytes = MEDIA_MAX_BYTES_BY_KIND[format];
    // Invalid picks are rejected before any byte moves — a retry could
    // never succeed for them.
    const valid: { file: File; target: number }[] = [];
    let cursor = 0;
    for (const file of files) {
      if (!spec.mimeTypes.includes(file.type)) {
        toast.error(
          t(format === 'image' ? 'toastInvalidImage' : 'toastInvalidVideo'),
        );
        continue;
      }
      if (file.size > maxBytes) {
        toast.error(
          t('toastMediaTooLarge', {
            size: (file.size / 1024 / 1024).toFixed(1),
            max: Math.round(maxBytes / 1024 / 1024),
          }),
        );
        continue;
      }
      valid.push({ file, target: (startIndex + cursor) % data.cards.length });
      cursor += 1;
    }
    if (valid.length === 0) return;

    for (let i = 0; i < valid.length; i += UPLOAD_CONCURRENCY) {
      const chunk = valid.slice(i, i + UPLOAD_CONCURRENCY);
      chunk.forEach(({ target }) =>
        setUploading((prev) => ({ ...prev, [target]: true })),
      );
      const results = await Promise.allSettled(
        chunk.map(({ file }) => uploadAccountMedia('chat-media', file)),
      );
      results.forEach((result, j) => {
        const { file, target } = chunk[j];
        if (result.status === 'fulfilled') {
          updateCard(target, (c) => ({
            ...c,
            media_url: result.value.publicUrl,
            // A new asset invalidates the previous creation handle.
            media_handle: null,
            media_filename: file.name,
            media_size: file.size,
          }));
          setFailedFiles((prev) => {
            if (!(target in prev)) return prev;
            const next = { ...prev };
            delete next[target];
            return next;
          });
        } else {
          toast.error(
            result.reason instanceof Error
              ? result.reason.message
              : t('toastUploadFailed'),
          );
          // Keep the file so the card's zone can offer a real retry.
          setFailedFiles((prev) => ({ ...prev, [target]: file }));
        }
      });
      chunk.forEach(({ target }) =>
        setUploading((prev) => ({ ...prev, [target]: false })),
      );
    }
  }

  // ── card text variable insertion (same caret behavior as the body) ─

  const cardTextRef = React.useRef<HTMLTextAreaElement>(null);

  function addCardVariable() {
    const card = data.cards[safeActive];
    if (!card) return;
    const indices = extractVariableIndices(card.text ?? '');
    const nextVar = (indices.length ? Math.max(...indices) : 0) + 1;
    const token = `{{${nextVar}}}`;
    const el = cardTextRef.current;
    const pos =
      el && typeof el.selectionStart === 'number'
        ? el.selectionStart
        : (card.text ?? '').length;
    const caret = pos + token.length;
    updateCard(safeActive, (c) =>
      syncTextExamples({
        ...c,
        text: (c.text ?? '').slice(0, pos) + token + (c.text ?? '').slice(pos),
      }),
    );
    requestAnimationFrame(() => {
      if (cardTextRef.current) {
        cardTextRef.current.focus();
        cardTextRef.current.setSelectionRange(caret, caret);
      }
    });
  }

  return (
    <div className="space-y-4 rounded-md border border-border bg-muted/30 p-3">
      <p className="sr-only" aria-live="polite">{announcement}</p>

      {/* ── 1. Shared settings (identical-by-construction) ─────────── */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            {t('carouselMediaLabel')}
          </Label>
          <div className="flex gap-1" role="group" aria-label={t('carouselMediaLabel')}>
            {(['image', 'video'] as const).map((format) => (
              <Button
                key={format}
                type="button"
                size="sm"
                variant={data.media_format === format ? 'default' : 'outline'}
                aria-pressed={data.media_format === format}
                onClick={() => switchMediaFormat(format)}
                className="flex-1 h-8 text-xs"
              >
                {t(format === 'image' ? 'headerImage' : 'headerVideo')}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            {t('carouselButtonLayout')}
          </Label>
          <div className="flex gap-1" role="group" aria-label={t('carouselButtonLayout')}>
            {[1, 2].map((count) => (
              <Button
                key={count}
                type="button"
                size="sm"
                variant={layoutKinds.length === count ? 'default' : 'outline'}
                aria-pressed={layoutKinds.length === count}
                onClick={() => {
                  if (count === layoutKinds.length) return;
                  const kinds =
                    count === 1
                      ? layoutKinds.slice(0, 1)
                      : [...layoutKinds, 'QUICK_REPLY' as CarouselButtonKind];
                  setButtonLayout(kinds);
                }}
                className="flex-1 h-8 text-xs"
              >
                {t(count === 1 ? 'carouselOneButton' : 'carouselTwoButtons')}
              </Button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 self-end pb-1.5 cursor-pointer">
          <Checkbox
            checked={data.cards_have_text}
            onCheckedChange={(checked) =>
              mutate((d) => ({ ...d, cards_have_text: checked === true }))
            }
            aria-label={t('carouselCardsHaveText')}
          />
          <span className="text-xs text-muted-foreground">
            {t('carouselCardsHaveText')}
          </span>
        </label>
      </div>

      {layoutKinds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {layoutKinds.map((kind, slot) => (
            <Select
              key={slot}
              value={kind}
              onValueChange={(val) => {
                if (!val) return;
                const next = [...layoutKinds];
                next[slot] = val as CarouselButtonKind;
                setButtonLayout(next);
              }}
            >
              <SelectTrigger
                className="w-36 h-7 text-xs bg-muted border-border text-foreground"
                aria-label={t('carouselButtonLayout') + ` ${slot + 1}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border">
                {(['QUICK_REPLY', 'URL', 'PHONE_NUMBER'] as const).map((k) => (
                  <SelectItem
                    key={k}
                    value={k}
                    className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                  >
                    {t(BUTTON_KIND_LABEL_KEY[k])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
          <p className="text-[11px] text-muted-foreground">
            {t('buttonsLimit', { max: CAROUSEL_LIMITS.maxButtonsPerCard })}
          </p>
        </div>
      )}

      {/* ── 2. Card strip ───────────────────────────────────────────── */}
      <div className="space-y-2">
        <DndContext
          sensors={useSensors(
            useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
            useSensor(KeyboardSensor),
          )}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={data.cards.map((_, i) => i)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex gap-2 overflow-x-auto pb-1" role="list">
              {data.cards.map((card, index) => (
                <CardChip
                  key={index}
                  index={index}
                  card={card}
                  mediaFormat={data.media_format}
                  active={index === safeActive}
                  incomplete={!isCarouselCardComplete(data, card, index)}
                  onSelect={onActiveCardChange}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addCard}
            disabled={cardCount >= CAROUSEL_LIMITS.maxCards}
            className="h-7 border-border bg-transparent text-xs text-muted-foreground hover:bg-muted"
          >
            <Plus className="size-3" />
            {t('carouselAddCard')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => duplicateCard(safeActive)}
            disabled={cardCount >= CAROUSEL_LIMITS.maxCards}
            aria-label={t('carouselDuplicateCardAria', { n: safeActive + 1 })}
            className="size-7 text-muted-foreground hover:bg-muted"
          >
            <Copy className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => deleteCard(safeActive)}
            disabled={cardCount <= CAROUSEL_LIMITS.minCards}
            aria-label={t('carouselDeleteCardAria', { n: safeActive + 1 })}
            className="size-7 text-muted-foreground hover:bg-red-950/30 hover:text-red-400"
          >
            <Trash2 className="size-3.5" />
          </Button>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {cardCount}/{CAROUSEL_LIMITS.maxCards}
          </span>
        </div>
      </div>

      {/* ── 3. Active card editor ───────────────────────────────────── */}
      {activeCardData && (
        <div className="space-y-3 rounded border border-border bg-background/50 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            {t('carouselCardLabel', { n: safeActive + 1 })}
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept={MEDIA_HEADER_SPECS[data.media_format].mimeTypes.join(',')}
            multiple
            className="hidden"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length) void uploadFiles(picked, safeActive);
              e.target.value = '';
            }}
          />

          {activeCardData.media_url ? (
            <div className="flex items-center gap-3">
              {data.media_format === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={activeCardData.media_url}
                  alt=""
                  className="h-16 w-28 rounded object-cover border border-border"
                />
              ) : (
                <video
                  src={activeCardData.media_url}
                  preload="metadata"
                  muted
                  playsInline
                  className="h-16 w-28 rounded object-cover border border-border bg-black"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-foreground">
                  {activeCardData.media_filename ??
                    activeCardData.media_url.split('/').pop()}
                </p>
                {typeof activeCardData.media_size === 'number' && (
                  <p className="text-[11px] text-muted-foreground">
                    {formatFileSize(activeCardData.media_size)}
                  </p>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading[safeActive]}
                className="h-7 text-xs border-border"
              >
                {t('carouselReplace')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  updateCard(safeActive, (c) => ({
                    ...c,
                    media_url: null,
                    media_handle: null,
                    media_filename: null,
                    media_size: null,
                  }))
                }
                className="h-7 text-xs text-muted-foreground hover:text-red-400"
              >
                {t('carouselRemove')}
              </Button>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              aria-label={t('carouselDropHint')}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const dropped = Array.from(e.dataTransfer.files ?? []);
                if (dropped.length) void uploadFiles(dropped, safeActive);
              }}
              className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded border border-dashed border-border bg-muted/40 px-3 py-5 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {uploading[safeActive] ? (
                <>
                  <Loader2 className="size-4 animate-spin text-primary" />
                  <span className="text-[11px] text-muted-foreground">
                    {t('carouselUploading')}
                  </span>
                </>
              ) : (
                <>
                  <Upload className="size-4 text-muted-foreground" />
                  <span className="text-[11px] text-muted-foreground">
                    {t('carouselDropHint')}
                  </span>
                  <span className="text-[10px] text-muted-foreground/80">
                    {t(
                      data.media_format === 'image' ? 'uploadHint' : 'uploadHintVideo',
                    )}
                  </span>
                </>
              )}
            </div>
          )}

          {failedFiles[safeActive] && (
            <div className="flex items-center gap-2 text-xs text-red-400">
              <AlertCircle className="size-3.5" />
              <span>{t('carouselUploadFailed')}</span>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-6 px-0 text-[11px]"
                onClick={() => {
                  const file = failedFiles[safeActive];
                  if (file) void uploadFiles([file], safeActive);
                }}
              >
                {t('formsRetry')}
              </Button>
            </div>
          )}

          {data.cards_have_text && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[11px] text-muted-foreground">
                  {t('carouselCardText')}
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addCardVariable}
                  className="h-6 border-border bg-transparent text-[11px] text-muted-foreground hover:bg-muted"
                >
                  <Plus className="size-3" />
                  {t('addVariable')}
                </Button>
              </div>
              <Textarea
                ref={cardTextRef}
                value={activeCardData.text ?? ''}
                onChange={(e) =>
                  updateCard(safeActive, (c) =>
                    syncTextExamples({ ...c, text: e.target.value }),
                  )
                }
                rows={2}
                maxLength={CAROUSEL_LIMITS.cardTextMaxLength}
                placeholder={t.raw('bodyPlaceholder')}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground resize-none text-xs"
              />
              <p className="text-right text-[11px] tabular-nums text-muted-foreground">
                {(activeCardData.text ?? '').length}/
                {CAROUSEL_LIMITS.cardTextMaxLength}
              </p>
              {(activeCardData.text_examples ?? []).map((val, vi) => (
                <Input
                  key={vi}
                  aria-label={t('sampleAria', { var: `{{${vi + 1}}}` })}
                  placeholder={t('samplePlaceholder', { var: `{{${vi + 1}}}` })}
                  value={val}
                  onChange={(e) =>
                    updateCard(safeActive, (c) => {
                      const next = [...(c.text_examples ?? [])];
                      next[vi] = e.target.value;
                      return { ...c, text_examples: next };
                    })
                  }
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                />
              ))}
            </div>
          )}

          {/* Per-button fields — the count and types come from the
              shared layout; only label / URL / number differ. */}
          {activeCardData.buttons.map((button, b) => (
            <div key={b} className="space-y-1.5 rounded border border-border/60 p-2">
              <p className="text-[11px] text-muted-foreground">
                {t('carouselButtonLayout')} {b + 1} · {t(BUTTON_KIND_LABEL_KEY[button.type])}
              </p>
              <Input
                placeholder={t('btnLabelPlaceholder')}
                value={button.text}
                maxLength={CAROUSEL_LIMITS.buttonLabelMaxLength}
                onChange={(e) =>
                  updateCard(safeActive, (c) => ({
                    ...c,
                    buttons: c.buttons.map((btn, i) =>
                      i === b ? { ...btn, text: e.target.value } : btn,
                    ),
                  }))
                }
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
              />
              {button.type === 'URL' && (
                <div className="space-y-1">
                  <Input
                    placeholder={t.raw('urlPlaceholder')}
                    value={button.url ?? ''}
                    onChange={(e) =>
                      updateCard(safeActive, (c) => ({
                        ...c,
                        buttons: c.buttons.map((btn, i) =>
                          i === b ? { ...btn, url: e.target.value } : btn,
                        ),
                      }))
                    }
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                  />
                  {/\{\{1\}\}/.test(button.url ?? '') && (
                    <Input
                      placeholder={t.raw('urlSamplePlaceholder')}
                      value={button.url_example ?? ''}
                      onChange={(e) =>
                        updateCard(safeActive, (c) => ({
                          ...c,
                          buttons: c.buttons.map((btn, i) =>
                            i === b
                              ? { ...btn, url_example: e.target.value }
                              : btn,
                          ),
                        }))
                      }
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                    />
                  )}
                </div>
              )}
              {button.type === 'PHONE_NUMBER' && (
                <Input
                  placeholder={t('phonePlaceholder')}
                  value={button.phone_number ?? ''}
                  onChange={(e) =>
                    updateCard(safeActive, (c) => ({
                      ...c,
                      buttons: c.buttons.map((btn, i) =>
                        i === b ? { ...btn, phone_number: e.target.value } : btn,
                      ),
                    }))
                  }
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 4. Validation summary ───────────────────────────────────── */}
      {issues.length > 0 && (
        <div className="space-y-1.5 rounded border border-red-800/50 bg-red-950/30 p-2.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-red-300">
            <AlertCircle className="size-3.5" />
            {t('carouselIssuesTitle')}
          </p>
          <ul className="space-y-1">
            {issues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-red-200">
                <span className="flex-1">{issue.message}</span>
                {issue.cardIndex !== null && (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="h-5 shrink-0 px-0 text-[11px] text-red-300 underline"
                    onClick={() => onActiveCardChange(issue.cardIndex as number)}
                  >
                    {t('carouselGoToCard', { n: (issue.cardIndex as number) + 1 })}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── sortable chip ────────────────────────────────────────────────────
// Memoized so typing into the active card never re-renders the other
// nine chips; callbacks are stable (the manager's setActiveCard and the
// panel's index-based onSelect).

interface CardChipProps {
  index: number;
  card: CarouselCard;
  mediaFormat: CarouselMediaFormat;
  active: boolean;
  incomplete: boolean;
  onSelect: (index: number) => void;
}

const CardChip = React.memo(function CardChip({
  index,
  card,
  mediaFormat,
  active,
  incomplete,
  onSelect,
}: CardChipProps) {
  const t = useTranslations('Settings.templates');
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: index });
  const label = t('carouselCardLabel', { n: index + 1 });

  return (
    <div
      ref={setNodeRef}
      role="listitem"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={
        'relative flex shrink-0 items-center gap-1 rounded border px-1.5 py-1 ' +
        (active
          ? 'border-primary bg-primary/10'
          : 'border-border bg-muted/40 hover:bg-muted')
      }
    >
      <button
        type="button"
        aria-label={t('carouselReorderCardAria', { n: index + 1 })}
        {...attributes}
        {...listeners}
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded p-0.5 active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </button>

      <button
        type="button"
        onClick={() => onSelect(index)}
        aria-pressed={active}
        aria-label={incomplete ? t('carouselCardIncompleteAria', { n: index + 1 }) : label}
        className="flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {card.media_url ? (
          mediaFormat === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.media_url}
              alt=""
              className="h-8 w-14 rounded object-cover border border-border"
            />
          ) : (
            <span className="relative inline-flex">
              <video
                src={card.media_url}
                preload="metadata"
                muted
                playsInline
                className="h-8 w-14 rounded object-cover border border-border bg-black"
              />
              <Play className="absolute inset-0 m-auto size-3.5 fill-white/90 text-white/90" />
            </span>
          )
        ) : (
          <span className="flex h-8 w-14 items-center justify-center rounded border border-dashed border-border bg-muted/50">
            <Upload className="size-3.5 text-muted-foreground" />
          </span>
        )}
        <span className="text-[11px] text-foreground whitespace-nowrap">{label}</span>
        {incomplete && (
          <span
            aria-hidden
            className="size-2 rounded-full bg-red-500 shrink-0"
          />
        )}
      </button>
    </div>
  );
});
