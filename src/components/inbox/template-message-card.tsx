"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Copy,
  CornerDownLeft,
  ExternalLink,
  FileText,
  FormInput,
  Phone,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type {
  TemplateMessagePayload,
  TemplatePayloadButton,
  TemplatePayloadHeader,
} from "@/types";
import { splitWhatsAppMarkup } from "@/lib/whatsapp/template-render";
import { useMediaBlobUrl } from "@/hooks/use-media-blob-url";

/**
 * A delivered WhatsApp template, rendered the way the recipient sees it:
 * header (text, image, video or document), body, footer, then the button
 * row. Driven entirely by the `messages.template_payload` snapshot
 * (migration 053) — or, for a message sent before it existed, by the
 * reconstruction in `resolveTemplateRender` — so nothing here reads a
 * live `message_templates` row and a later template edit cannot rewrite
 * chat history.
 *
 * The SURFACE belongs to the caller: <MessageBubble> gives a template its
 * own WhatsApp-green bubble (`bg-chat-bubble`) instead of the themed
 * accent fill, because an approved creative is artwork, not chat chrome —
 * a blue or violet tint over it misreports what the customer saw. This
 * component therefore owns only the sections inside that bubble and pads
 * each one itself, which is what lets a media header sit flush against
 * the bubble edges exactly like it does on the phone.
 *
 * The phone-mockup preview in Settings keeps its own fixed-palette
 * renderer (`@/components/settings/template-preview`) — that one simulates
 * a customer's screen; this one is the record of an actual send.
 */

/** Media headers share the phone's cap: tall enough to read a creative,
 *  short enough that the body never falls off the thread. */
const HEADER_MEDIA = "max-h-80 w-full object-contain";

/**
 * WhatsApp body/header text with its four markup flavours resolved.
 * `content_text` used to be dumped raw, so a body written as
 * `*Contact : 9640111265*` showed its asterisks. An unpaired delimiter
 * stays literal (see `splitWhatsAppMarkup`), which is exactly what
 * WhatsApp does too.
 */
function MarkupText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  // No size in the base: the header and the body are different sizes on
  // the phone, and a `text-sm` here would fight whichever caller wins.
  return (
    <p className={cn("whitespace-pre-wrap break-words", className)}>
      {splitWhatsAppMarkup(text).map((token, i) => {
        switch (token.style) {
          case "bold":
            return (
              <strong key={i} className="font-semibold">
                {token.text}
              </strong>
            );
          case "italic":
            return <em key={i}>{token.text}</em>;
          case "strike":
            return <s key={i}>{token.text}</s>;
          case "mono":
            return (
              <code
                key={i}
                className="rounded bg-chat-bubble-foreground/10 px-0.5 font-mono text-[0.85em]"
              >
                {token.text}
              </code>
            );
          default:
            return <span key={i}>{token.text}</span>;
        }
      })}
    </p>
  );
}

function HeaderPlaceholder({
  label,
  t,
}: {
  label: string;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="mx-2.5 my-2 flex h-16 w-40 max-w-[calc(100%-1.25rem)] items-center justify-center rounded-lg bg-chat-bubble-foreground/10 text-[11px] text-chat-bubble-muted">
      {t("unavailable", { label })}
    </div>
  );
}

/**
 * Image header. Hook is called unconditionally in this component, which
 * is why the header splits by kind into three small renderers rather
 * than branching inline.
 */
function HeaderImage({
  url,
  t,
}: {
  url: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const { src, status } = useMediaBlobUrl(url);
  // The URL can load and still not decode as an image.
  const [broken, setBroken] = useState(false);

  if (status === "error" || broken) return <BrokenPlaceholder label={t("photo")} />;
  if (status !== "ready" || !src) {
    return (
      <div className="flex h-40 w-full items-center justify-center bg-chat-bubble-foreground/5">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-chat-bubble-link border-t-transparent" />
      </div>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={t("viewImage")}
      aria-label={t("viewImage")}
      className="block"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={t("imageAlt")}
        className={cn(HEADER_MEDIA, "block")}
        onError={() => setBroken(true)}
      />
    </a>
  );
}

function BrokenPlaceholder({ label }: { label: string }) {
  return (
    <div className="mx-2.5 my-2 flex h-16 w-40 max-w-[calc(100%-1.25rem)] items-center gap-2 rounded-lg bg-chat-bubble-foreground/10 px-3 text-xs text-chat-bubble-muted">
      <FileText className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}

function TemplateHeader({
  header,
  t,
}: {
  header: TemplatePayloadHeader;
  t: ReturnType<typeof useTranslations>;
}) {
  if (header.kind === "text") {
    if (!header.text) return null;
    // WhatsApp shows a text header in the body's own size, not bold.
    return (
      <MarkupText
        text={header.text}
        className="px-2.5 pt-2 text-[13px] font-medium leading-snug"
      />
    );
  }

  if (!header.mediaUrl) {
    const label =
      header.kind === "image"
        ? t("photo")
        : header.kind === "video"
          ? t("video")
          : t("document");
    return <HeaderPlaceholder label={label} t={t} />;
  }

  if (header.kind === "image") return <HeaderImage url={header.mediaUrl} t={t} />;

  if (header.kind === "video") {
    // Plain URL, never a blob — the element should stream the clip
    // instead of buffering up to Meta's 16 MB cap before it plays
    // (same rule as the media bubbles in message-media.tsx).
    return (
      <video
        src={header.mediaUrl}
        controls
        preload="metadata"
        className={cn(HEADER_MEDIA, "bg-black/20")}
      />
    );
  }

  return (
    <a
      href={header.mediaUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="mx-2.5 my-2 flex w-fit max-w-[calc(100%-1.25rem)] items-center gap-2 rounded-lg bg-chat-bubble-foreground/10 px-2.5 py-2 text-sm"
    >
      <FileText className="h-5 w-5 shrink-0" />
      <span className="truncate">{header.filename || t("document")}</span>
    </a>
  );
}

/** Only http(s) may become a live link — a synced template is data. */
function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/** Digits and a leading `+` only, so `tel:` can't be given a scheme. */
function dialNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return cleaned.length >= 4 ? cleaned : null;
}

function ButtonRow({
  button,
  t,
}: {
  button: TemplatePayloadButton;
  t: ReturnType<typeof useTranslations>;
}) {
  // WhatsApp renders each template button as a centred, accent-coloured
  // label with its type icon — not a filled pill, and nothing to press
  // for an agent unless it is a real link, call or code.
  const base =
    "flex w-full items-center justify-center gap-1.5 py-1 text-center text-[13px] font-medium text-chat-bubble-link";
  const label = button.text || button.type;

  switch (button.type) {
    case "URL": {
      const href = safeHttpUrl(button.url);
      if (!href) {
        // Unsubstituted `{{1}}` or a non-http template URL: show the
        // destination rather than inventing a link that would 404.
        return (
          <span className={base} title={button.url ?? undefined}>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{label}</span>
          </span>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(base, "hover:underline")}
          title={href}
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </a>
      );
    }

    case "PHONE_NUMBER": {
      const dial = dialNumber(button.phoneNumber);
      if (!dial) return <span className={base}>{label}</span>;
      return (
        <a
          href={`tel:${dial}`}
          className={cn(base, "hover:underline")}
          title={button.phoneNumber ?? undefined}
        >
          <Phone className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </a>
      );
    }

    case "COPY_CODE": {
      const code = button.code ?? "";
      return (
        <button
          type="button"
          title={code || undefined}
          onClick={async () => {
            if (!code) return;
            try {
              await navigator.clipboard.writeText(code);
              toast.success(t("codeCopied"));
            } catch {
              toast.error(t("copyCodeFailed"));
            }
          }}
          className={cn(base, "hover:underline")}
        >
          <Copy className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      );
    }

    case "QUICK_REPLY":
      // The customer's tap target — nothing for an agent to press here,
      // so it reads as a button and says what it does on hover. The
      // handset shows a reply arrow for these, not a speech bubble.
      return (
        <span className={base} title={t("quickReplyHint")}>
          <CornerDownLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
      );

    case "FLOW":
      return (
        <span className={base} title={t("flowHint")}>
          <FormInput className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
      );
  }
}

export function TemplateMessageCard({
  payload,
}: {
  payload: TemplateMessagePayload;
}) {
  const t = useTranslations("Inbox.bubble");

  return (
    <div className="min-w-0">
      {payload.header && <TemplateHeader header={payload.header} t={t} />}

      {payload.body && (
        <MarkupText
          text={payload.body}
          className="px-2.5 pt-1.5 pb-1 text-sm leading-[19px]"
        />
      )}

      {payload.footer && (
        <p className="px-2.5 pb-1 text-[11px] italic leading-snug text-chat-bubble-muted">
          {payload.footer}
        </p>
      )}

      {payload.buttons.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-chat-bubble-border px-2.5 py-1">
          {payload.buttons.map((button, i) => (
            <ButtonRow key={i} button={button} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}
