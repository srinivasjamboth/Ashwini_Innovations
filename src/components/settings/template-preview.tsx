'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Video, Phone, MoreVertical, CheckCheck, CornerDownLeft, ExternalLink, ClipboardCopy, Workflow, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { CarouselTemplateData, TemplateButton } from '@/types';
import { carouselCardPreviewText } from '@/lib/whatsapp/carousel';
import { cn } from '@/lib/utils';

/**
 * A live, WhatsApp-style preview of the template being built. It mirrors
 * what Meta's reviewers (and ultimately the customer) will see: header →
 * body (with {{n}} variables swapped for their sample values) → footer →
 * buttons, rendered inside a phone frame.
 *
 * It is purely presentational — it reads the same form state the editor
 * writes and never mutates anything, so it can't affect submit/validation.
 * The WhatsApp green/beige colours are deliberate brand colours for a
 * faithful mock, not the app's own theme tokens. The bezel is a deep sea
 * blue (#015482) — a literal class value, so Tailwind can still see it;
 * change all three occurrences together if the shade needs adjusting.
 */
interface TemplatePreviewProps {
  headerFormat: 'none' | 'text' | 'image' | 'video' | 'document' | 'carousel';
  headerContent: string;
  headerMediaUrl: string;
  bodyText: string;
  bodySamples: string[];
  footerText: string;
  buttons: TemplateButton[];
  businessName: string;
  /**
   * Render each button with its type icon (Quick Reply, Visit Website,
   * Call Phone, Form). Off by default so the builder preview keeps its
   * exact current look; the read-only "View template" panel turns it on
   * as the spec asks. Same renderer either way — never a second one.
   */
  showButtonIcons?: boolean;
  /**
   * Let the chat area scroll when a template is taller than the phone
   * frame instead of clipping it. Off by default so the builder preview
   * keeps its exact current (fixed-height) behaviour; the read-only
   * "View template" popup turns it on so long messages stay reviewable.
   */
  scrollableContent?: boolean;
  /**
   * Override the bezel colour (applied to the frame's border AND
   * background together). Omitted = the classic deep sea blue #015482,
   * so the builder and the view popup are pixel-identical to before;
   * only callers that opt in get a different frame.
   */
  frameColor?: string;
  /**
   * Up to two initials for the header avatar. When set they replace the
   * single first-letter glyph (rendered slightly smaller so they never
   * clip inside the 32px circle). Omitted = current single-letter look.
   */
  businessInitials?: string;
  /**
   * Replace the empty-state line ("Start typing…" is wrong for a
   * read-only selection preview). Omitted = the builder's own copy.
   */
  emptyMessage?: string;
  /**
   * Media card carousel. Only read when `headerFormat === 'carousel'`,
   * so every existing preview (none/text/image/video/document) renders
   * exactly as before.
   */
  carousel?: CarouselTemplateData | null;
  /**
   * Card the carousel preview should scroll to — the builder passes the
   * card being edited so the strip and the phone stay in step. Ignored
   * by the read-only preview, which leaves the row at its first card.
   */
  carouselActiveCard?: number;
}

// Split on {{n}} tokens, replacing each with its sample value when one has
// been entered (otherwise the raw token stays visible, highlighted).
function renderVariables(text: string, samples: string[]) {
  return text.split(/(\{\{\d+\}\})/g).map((part, i) => {
    const m = part.match(/^\{\{(\d+)\}\}$/);
    if (!m) return <span key={i}>{part}</span>;
    const sample = samples[Number(m[1]) - 1]?.trim();
    return sample ? (
      <span key={i} className="font-medium text-[#111b21]">
        {sample}
      </span>
    ) : (
      <span key={i} className="font-medium text-[#3b5a72]">
        {part}
      </span>
    );
  });
}

export function TemplatePreview({
  headerFormat,
  headerContent,
  headerMediaUrl,
  bodyText,
  bodySamples,
  footerText,
  buttons,
  businessName,
  showButtonIcons = false,
  scrollableContent = false,
  frameColor,
  businessInitials,
  emptyMessage,
  carousel,
  carouselActiveCard,
}: TemplatePreviewProps) {
  const t = useTranslations('Settings.templates');
  const now = new Date().toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  // A carousel has no header, no footer and no top-level buttons at all:
  // its media lives on the cards. Everything below is gated on this flag,
  // so the other five header formats render exactly as before.
  const isCarousel = headerFormat === 'carousel';
  const carouselCards = isCarousel ? (carousel?.cards ?? []) : [];

  const headerIsText = headerFormat === 'text' && Boolean(headerContent.trim());
  const headerIsMedia =
    !isCarousel &&
    headerFormat !== 'none' &&
    headerFormat !== 'text' &&
    Boolean(headerMediaUrl.trim());
  // Media header chosen but its link is unavailable (e.g. a synced
  // template whose asset never carried a URL) — show a labelled
  // placeholder instead of silently dropping the header.
  const headerMediaMissing =
    !isCarousel &&
    headerFormat !== 'none' &&
    headerFormat !== 'text' &&
    !headerMediaUrl.trim();
  const hasContent =
    headerIsText ||
    headerIsMedia ||
    Boolean(bodyText.trim()) ||
    carouselCards.length > 0 ||
    (!isCarousel && buttons.length > 0);

  // Two initials when the caller provides them (smaller text keeps them
  // inside the size-8 circle), otherwise the original single letter.
  const initials = businessInitials?.trim().slice(0, 2).toUpperCase() ?? '';
  const avatarContent = initials || businessName.trim().charAt(0).toUpperCase() || 'B';

  return (
    // Right-aligned from lg up (the sticky preview column is wider than the
    // phone) but still centred while stacked on mobile.
    <div className="mx-auto w-full max-w-[300px] lg:mr-0 lg:ml-auto">
      <p className="mb-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t('previewLabel')}
      </p>
      {/* Phone frame — real-device proportions (9:19 w:h) with the flexible
        * chat area absorbing the extra height, so long templates simply
        * grow the device instead of squashing it back to a stub. */}
      <div
        className="flex aspect-[9/19] w-full flex-col overflow-hidden rounded-[2.4rem] border-[10px] border-[#015482] bg-[#015482] shadow-2xl"
        style={frameColor ? { borderColor: frameColor, backgroundColor: frameColor } : undefined}
      >
        {/* Status bar (with a punch-hole / dynamic-island cut-out) */}
        <div className="relative flex shrink-0 items-center justify-between bg-[#075E54] px-4 pt-2.5 pb-1.5 text-[10px] font-medium text-white/90">
          <span>{now}</span>
          <span
            aria-hidden
            className="absolute top-1.5 left-1/2 h-4 w-[74px] -translate-x-1/2 rounded-full bg-[#0b1418]"
          />
          <span className="tracking-[0.15em]">▮▮▮ ⌁ </span>
        </div>

        {/* Chat header */}
        <div className="flex shrink-0 items-center gap-2 bg-[#075E54] px-2 pb-2 text-white">
          <ChevronLeft className="size-5 shrink-0" />
          <div
            className={cn(
              'flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/85 font-semibold text-[#075E54]',
              initials ? 'text-[11px] leading-none' : 'text-sm',
            )}
          >
            {avatarContent}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-medium">
              {businessName.trim() || t('previewBusinessAccount')}
            </p>
            <p className="truncate text-[10px] text-white/70">
              {t('previewBusinessAccount')}
            </p>
          </div>
          <Video className="size-4 shrink-0" />
          <Phone className="size-4 shrink-0" />
          <MoreVertical className="size-4 shrink-0" />
        </div>

        {/* Conversation — fills whatever height the device shape leaves.
            Scrolls when scrollableContent is set (the read-only preview),
            otherwise clips exactly as the builder has always rendered. */}
        <div
          className={cn(
            'min-h-0 flex-1 space-y-2 bg-[#ECE5DD] p-3',
            scrollableContent ? 'overflow-y-auto' : 'overflow-hidden',
          )}
        >
          <div className="flex justify-center">
            <span className="rounded-md bg-white/90 px-2 py-0.5 text-[10px] text-neutral-600 shadow-sm">
              {t('previewToday')}
            </span>
          </div>

          {hasContent ? (
            <div className="max-w-[85%] rounded-lg rounded-tl-none bg-white p-2 text-[13px] leading-snug text-[#111b21] shadow-sm">
              {headerIsText && (
                <p className="mb-1 font-medium">{renderVariables(headerContent, [])}</p>
              )}
              {headerIsMedia && (
                <div className="mb-1.5 flex h-28 items-center justify-center overflow-hidden rounded bg-neutral-100 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                  {headerFormat === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={headerMediaUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span>{headerFormat}</span>
                  )}
                </div>
              )}
              {headerMediaMissing && (
                <div className="mb-1.5 flex h-28 items-center justify-center rounded bg-neutral-100 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                  {headerFormat}
                </div>
              )}
              {bodyText.trim() && (
                <p className="whitespace-pre-wrap break-words">
                  {renderVariables(bodyText, bodySamples)}
                </p>
              )}
              {carouselCards.length > 0 && (
                <CarouselCards data={carousel!} activeCard={carouselActiveCard} />
              )}
              {!isCarousel && footerText.trim() && (
                <p className="mt-1 text-[11px] italic text-neutral-500">{footerText}</p>
              )}
              {!isCarousel && buttons.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-neutral-200 pt-1.5">
                  {buttons.map((b, i) => (
                    <p
                      key={i}
                      className="flex items-center justify-center gap-1.5 py-0.5 text-center text-[12px] font-medium text-[#075E54]"
                    >
                      {showButtonIcons && <ButtonIcon type={b.type} />}
                      {b.text.trim() || '—'}
                    </p>
                  ))}
                </div>
              )}
              <div className="mt-1 flex items-center justify-end gap-1 text-[9px] text-neutral-400">
                <span>{now}</span>
                <CheckCheck className="size-3 text-sky-500" />
              </div>
            </div>
          ) : (
            <p className="mt-8 text-center text-[11px] text-neutral-500">
              {emptyMessage ?? t('previewEmpty')}
            </p>
          )}
        </div>

        {/* Home indicator (sits on the bezel colour) */}
        <div className="flex shrink-0 items-center justify-center py-2">
          <span aria-hidden className="h-1 w-24 rounded-full bg-white/45" />
        </div>
      </div>

      {carouselCards.length > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {t('carouselCropNote')}
        </p>
      )}
    </div>
  );
}

/**
 * The swipeable card row inside the bubble — wide-cropped media, card
 * text with its sample values substituted, then the card's buttons, in
 * the order the template defines them. Horizontally scrollable with snap,
 * so a 10-card carousel behaves like it does on the phone.
 */
function CarouselCards({
  data,
  activeCard,
}: {
  data: CarouselTemplateData;
  activeCard?: number;
}) {
  const t = useTranslations('Settings.templates');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  // Follow the card the author is editing. No-op for the read-only
  // preview, which never passes an index.
  useEffect(() => {
    if (activeCard === undefined) return;
    const scroller = scrollRef.current;
    const target = scroller?.children[activeCard] as HTMLElement | undefined;
    if (!scroller || !target) return;
    scroller.scrollTo({
      left: target.offsetLeft - scroller.offsetLeft,
      behavior: 'smooth',
    });
  }, [activeCard, data.cards.length]);

  return (
    <div className="mt-2">
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el || el.clientWidth === 0) return;
          const next = Math.min(
            data.cards.length - 1,
            Math.round(el.scrollLeft / el.clientWidth),
          );
          setActive((prev) => (prev === next ? prev : next));
        }}
        className="[-ms-overflow-style:none] [scrollbar-width:none] flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1"
      >
        {data.cards.map((card, i) => (
          <div
            key={i}
            className="w-[82%] shrink-0 snap-start overflow-hidden rounded-lg border border-neutral-200 bg-white"
          >
            <div className="relative aspect-[2/1] bg-neutral-100">
              {card.media_url ? (
                data.media_format === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={card.media_url}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <>
                    <video
                      src={card.media_url}
                      preload="metadata"
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <Play className="size-6 fill-white/80 text-white/90 drop-shadow" />
                    </span>
                  </>
                )
              ) : (
                <span className="absolute inset-0 flex items-center justify-center text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                  {data.media_format}
                </span>
              )}
            </div>
            {data.cards_have_text && (
              <p className="px-2 pt-1.5 text-[12px] leading-snug break-words">
                {renderVariables(carouselCardPreviewText(card), card.text_examples ?? [])}
              </p>
            )}
            <div className="mt-1.5 border-t border-neutral-200 py-1">
              {card.buttons.map((button, b) => (
                <p
                  key={b}
                  className="flex items-center justify-center gap-1 py-0.5 text-center text-[11px] font-medium text-[#075E54]"
                >
                  {button.type === 'QUICK_REPLY' && <CornerDownLeft className="size-3 shrink-0 opacity-80" />}
                  {button.type === 'URL' && <ExternalLink className="size-3 shrink-0 opacity-80" />}
                  {button.type === 'PHONE_NUMBER' && <Phone className="size-3 shrink-0 opacity-80" />}
                  {button.text.trim() || '—'}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* Page dots — WhatsApp's own cue that the row scrolls. */}
      <div className="mt-1 flex justify-center gap-1" aria-hidden>
        {data.cards.map((_, i) => (
          <span
            key={i}
            className={cn(
              'h-1 rounded-full transition-all',
              i === active ? 'w-2.5 bg-neutral-500' : 'w-1 bg-neutral-300',
            )}
          />
        ))}
      </div>
      <p className="sr-only">{t('carouselScrollHint', { count: data.cards.length })}</p>
    </div>
  );
}

/** Type icon for a template button in the preview — WhatsApp shows a
 * small glyph next to each interactive button. */
function ButtonIcon({ type }: { type: TemplateButton['type'] }) {
  const cls = 'size-3 shrink-0 opacity-80';
  switch (type) {
    case 'QUICK_REPLY':
      return <CornerDownLeft className={cls} />;
    case 'URL':
      return <ExternalLink className={cls} />;
    case 'PHONE_NUMBER':
      return <Phone className={cls} />;
    case 'COPY_CODE':
      return <ClipboardCopy className={cls} />;
    case 'FLOW':
      return <Workflow className={cls} />;
  }
}
