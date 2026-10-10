'use client';

import { ChevronLeft, Video, Phone, MoreVertical, CheckCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { TemplateButton } from '@/types';

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
  headerFormat: 'none' | 'text' | 'image' | 'video' | 'document';
  headerContent: string;
  headerMediaUrl: string;
  bodyText: string;
  bodySamples: string[];
  footerText: string;
  buttons: TemplateButton[];
  businessName: string;
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
}: TemplatePreviewProps) {
  const t = useTranslations('Settings.templates');
  const now = new Date().toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  const headerIsText = headerFormat === 'text' && Boolean(headerContent.trim());
  const headerIsMedia =
    headerFormat !== 'none' &&
    headerFormat !== 'text' &&
    Boolean(headerMediaUrl.trim());
  const hasContent =
    headerIsText || headerIsMedia || Boolean(bodyText.trim()) || buttons.length > 0;

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
      <div className="flex aspect-[9/19] w-full flex-col overflow-hidden rounded-[2.4rem] border-[10px] border-[#015482] bg-[#015482] shadow-2xl">
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
          <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/85 text-sm font-semibold text-[#075E54]">
            {businessName.trim().charAt(0).toUpperCase() || 'B'}
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

        {/* Conversation — fills whatever height the device shape leaves */}
        <div className="min-h-0 flex-1 space-y-2 bg-[#ECE5DD] p-3 overflow-hidden">
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
              {bodyText.trim() && (
                <p className="whitespace-pre-wrap break-words">
                  {renderVariables(bodyText, bodySamples)}
                </p>
              )}
              {footerText.trim() && (
                <p className="mt-1 text-[11px] italic text-neutral-500">{footerText}</p>
              )}
              {buttons.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-neutral-200 pt-1.5">
                  {buttons.map((b, i) => (
                    <p
                      key={i}
                      className="py-0.5 text-center text-[12px] font-medium text-[#075E54]"
                    >
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
              {t('previewEmpty')}
            </p>
          )}
        </div>

        {/* Home indicator (sits on the bezel colour) */}
        <div className="flex shrink-0 items-center justify-center py-2">
          <span aria-hidden className="h-1 w-24 rounded-full bg-white/45" />
        </div>
      </div>
    </div>
  );
}
