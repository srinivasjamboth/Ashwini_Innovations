"use client";

import { cn } from "@/lib/utils";
import type {
  Message,
  MessageReaction,
  TemplateMessagePayload,
} from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  MapPin,
  LayoutTemplate,
  CornerDownLeft,
  Sparkles,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import {
  MediaAudioBubble,
  MediaDocumentBubble,
  MediaImageBubble,
  MediaUnavailable,
  MediaVideoBubble,
} from "./message-media";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { TemplateMessageCard } from "./template-message-card";
import { resolveTemplateRender, type TemplateIndex } from "@/lib/whatsapp/template-render";
import { useTranslations } from "next-intl";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /**
   * Opens the thread's media viewer on this message. Only images and videos
   * call it; omitted when the parent renders no viewer, in which case media
   * stays inline and non-clickable.
   */
  onOpenMedia?: (messageId: string) => void;
  /**
   * Live template rows, for the handful of messages that predate the
   * `template_payload` snapshot (migration 053). Optional: without it a
   * legacy template message renders exactly as it used to, so no caller
   * has to supply it to stay correct.
   */
  templates?: TemplateIndex;
}

/**
 * "[title] — [details]" for a failed message, or null when the row
 * predates migration 042 / Meta sent no reason. Shared by the status
 * icon's tooltip and the line under the bubble.
 */
function failureReason(message: Message): string | null {
  if (message.status !== "failed" || !message.error_title) return null;
  return message.error_details
    ? `${message.error_title} — ${message.error_details}`
    : message.error_title;
}

function StatusIcon({
  status,
  title,
}: {
  status: Message["status"];
  /** Tooltip for the failed state — Meta's reason, when we have one. */
  title?: string | null;
}) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return (
        <span className="inline-flex" title={title ?? undefined}>
          <XCircle className="h-3 w-3 text-red-400" />
        </span>
      );
    default:
      return null;
  }
}

function MessageContent({
  message,
  t,
  isAgent,
  onOpenMedia,
  templatePayload,
}: {
  message: Message;
  t: ReturnType<typeof useTranslations>;
  /** Outbound bubbles sit on the primary fill — badges must invert. */
  isAgent: boolean;
  onOpenMedia?: (messageId: string) => void;
  /**
   * The template this message delivered, resolved once by
   * <MessageBubble> (it needs the same answer to pick the bubble's own
   * surface). Null means there is nothing beyond the stored text.
   */
  templatePayload: TemplateMessagePayload | null;
}) {
  // Passed to the media bubbles as a no-arg callback; `undefined` when the
  // parent wired up no viewer, which is what makes them non-clickable.
  const openMedia = onOpenMedia ? () => onOpenMedia(message.id) : undefined;

  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImageBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <MediaVideoBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <MediaAudioBubble message={message} t={t} />
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      return <MediaDocumentBubble message={message} t={t} />;

    case "template": {
      // A template used to render as its body text alone (raw
      // `*asterisks*` and all) while the recipient saw a header, a styled
      // body, a footer and buttons. When we can describe the delivery —
      // from the snapshot stored at send time, or for older rows
      // reconstructed from the live template — the whole thing renders on
      // its own WhatsApp-green bubble and needs no label, because it now
      // looks like the message it is. The chip stays only for the
      // text-only fallback, where it is the sole clue that a template was
      // sent at all (issue #483's invisible `bg-primary/20 text-primary`
      // on the primary fill is why it inverts on outbound).
      if (templatePayload) {
        return <TemplateMessageCard payload={templatePayload} />;
      }
      return (
        <div>
          <span
            className={cn(
              "mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
              isAgent
                ? "bg-primary-foreground/20 text-primary-foreground"
                : "bg-primary/20 text-primary",
            )}
          >
            <LayoutTemplate className="h-3 w-3" />
            {t("template")}
          </span>
          {message.content_text ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          ) : (
            message.template_name && (
              <p className="mt-1 break-words text-sm italic opacity-80">
                {message.template_name}
              </p>
            )
          )}
        </div>
      );
    }

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || t("locationShared")}</span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || t("interactiveReply")}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("interactiveReply")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("unsupported")}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenMedia,
  templates,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");
  const failure = isAgent ? failureReason(message) : null;

  // A template we can describe gets its OWN WhatsApp-green bubble instead
  // of being a card inside the accent-filled one: on the customer's phone
  // the creative sat on the lightest green, so wrapping it in the theme's
  // blue/violet fill (plus a TEMPLATE tag) showed the agent our chrome
  // rather than the message. Every other content type — and a template we
  // cannot describe — keeps the themed bubble exactly as it was.
  const templatePayload =
    message.content_type === "template"
      ? resolveTemplateRender(message, templates)
      : null;
  const isTemplateBubble = templatePayload !== null;

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative",
          isTemplateBubble
            ? cn(
                // The card pads its own sections, so a media header can
                // run flush to the bubble edges; `overflow-hidden` gives
                // that header the bubble's rounded corners. The width cap
                // keeps a long body at handset proportions instead of
                // stretching the creative across a wide inbox panel.
                "max-w-[26rem] overflow-hidden rounded-lg bg-chat-bubble text-chat-bubble-foreground shadow-sm",
                isAgent ? "rounded-br-md" : "rounded-bl-md",
              )
            : cn(
                "rounded-2xl px-3 py-2",
                isAgent
                  ? "rounded-br-md bg-primary text-primary-foreground"
                  : "rounded-bl-md bg-muted text-foreground",
              ),
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            // The green bubble is its own surface: the neutral quote reads
            // on both of its modes, the primary-inverted one does not.
            onPrimary={isAgent && !isTemplateBubble}
          />
        )}
        <MessageContent
          message={message}
          t={t}
          isAgent={isAgent}
          onOpenMedia={onOpenMedia}
          templatePayload={templatePayload}
        />
        <div
          className={cn(
            "flex items-center gap-1",
            // Inside the green bubble the meta row belongs to the bubble's
            // own padding; elsewhere it keeps the gap under the content.
            isTemplateBubble ? "px-2.5 pb-1.5" : "mt-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {message.ai_generated && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide",
                isTemplateBubble
                  ? "bg-chat-bubble-foreground/15 text-chat-bubble-foreground"
                  : "bg-primary-foreground/20 text-primary-foreground",
              )}
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface, and a
              // template bubble uses the muted ink of its own green.
              isTemplateBubble
                ? "text-chat-bubble-muted"
                : isAgent
                  ? "text-primary-foreground/70"
                  : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} title={failure} />}
        </div>
      </div>
      {failure && (
        <p
          className="mt-0.5 px-1 text-[10px] leading-tight text-muted-foreground"
          title={failure}
        >
          {t("notDelivered")}: {failure}
        </p>
      )}
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
