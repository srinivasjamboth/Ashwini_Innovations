// ============================================================
// Template delivery snapshot — build, read and resolve the
// `messages.template_payload` that lets the Inbox show a WHOLE
// template (header, body, footer, buttons) instead of the body text
// alone.
//
// Why a snapshot at all? `messages.content_text` only ever carried the
// substituted body, so a delivered template rendered as a plain text
// bubble: no image/video/document header, no footer, no buttons — the
// agent could not see what the customer saw. The columns on
// `message_templates` describe the template as it exists NOW, so
// reading them at render time would show a later edit (or nothing at
// all, once the template is deleted). Snapshotting at send time is the
// only faithful record, and it is what migration 053 stores.
//
// Deliberately NOT the wire shape. `buildSendComponents`
// (template-send-builder.ts) omits components Meta already knows from
// the approved template — a static text header, an unchanged footer,
// a QUICK_REPLY button with no variable. A recipient still SEES those,
// so this module describes the delivered message as rendered on the
// phone. The two builders share their inputs (row + send-time params),
// never each other's decisions.
//
// Pure by contract: no DB, no React, no 'use client'. Every send site
// (server) and the bubble (client) import the same functions, so the
// snapshot cannot be built one way and read another.
// ============================================================

import type {
  Message,
  MessageTemplate,
  TemplateMessagePayload,
  TemplatePayloadButton,
  TemplatePayloadHeader,
  TemplateHeaderKind,
} from '@/types';

import { renderTemplateBody } from './template-body';

/** Header kinds we know how to render. Anything else → no header. */
const HEADER_KINDS = ['text', 'image', 'video', 'document'] as const;

function headerKind(value: string | undefined | null): TemplateHeaderKind | null {
  if (!value) return null;
  const v = value.toLowerCase();
  return (HEADER_KINDS as readonly string[]).includes(v)
    ? (v as TemplateHeaderKind)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export interface BuildTemplatePayloadArgs {
  /** The local `message_templates` row, when the send resolved one. */
  template: MessageTemplate | null | undefined;
  /** Template name actually sent (the row's may differ in case). */
  name: string;
  language?: string | null;
  /** Positional body values, in {{1}}, {{2}}… order. */
  bodyParams?: string[] | null;
  /** Value for a TEXT header's {{1}}. */
  headerText?: string | null;
  /** Send-time media override (per-recipient header image). */
  headerMediaUrl?: string | null;
  /**
   * Send-time media BY ID (`SendTimeParams.headerMediaId`) — a real
   * `/media` upload id. Recorded for fidelity: an id has no clickable
   * form, so the bubble still shows a labelled placeholder.
   */
  headerMediaId?: string | null;
  /** Per-button send-time values, keyed by button index. */
  buttonParams?: Record<number, string> | null;
  /**
   * Body the caller already rendered. The composer and the broadcast
   * fan-out both substitute client-side/planner-side; passing it keeps
   * the bubble byte-identical to `content_text` rather than re-rendering
   * from a row that may have been edited in between.
   */
  renderedBody?: string | null;
}

function buildHeader(
  template: MessageTemplate,
  args: BuildTemplatePayloadArgs,
): TemplatePayloadHeader | null {
  const kind = headerKind(template.header_type);
  if (!kind) return null;

  if (kind === 'text') {
    const raw = str(template.header_content);
    if (!raw) return null;
    // A text header with {{1}} shows the send-time value; a static one
    // shows itself. Unfilled tokens stay visible — same honesty rule as
    // renderTemplateBody, so a caller that under-supplied a param sees
    // {{1}} rather than a silently blank header.
    return {
      kind: 'text',
      text: args.headerText ? renderTemplateBody(raw, [args.headerText]) : raw,
      mediaUrl: null,
      mediaId: null,
      filename: null,
    };
  }

  // Media header. Prefer the override actually sent, then the template's
  // stored public URL. `header_handle` is NOT usable here: it is a
  // creation-time sample, not a renderable link (see
  // template-send-builder.ts). When neither exists the header still
  // existed — the bubble renders a labelled placeholder for it.
  const link = str(args.headerMediaUrl) ?? str(template.header_media_url);
  return {
    kind,
    text: null,
    mediaUrl: link,
    // Never `header_handle` — see the comment above. Only an explicit
    // send-time upload id belongs here.
    mediaId: str(args.headerMediaId),
    // Document headers carry their filename in header_content.
    filename: kind === 'document' ? str(template.header_content) : null,
  };
}

function buildButtons(
  template: MessageTemplate,
  args: BuildTemplatePayloadArgs,
): TemplatePayloadButton[] {
  const buttons = Array.isArray(template.buttons) ? template.buttons : [];
  return buttons.map((button, index) => {
    const override = args.buttonParams?.[index];
    // Every field present, null when unused: the same canonical shape
    // `parseTemplatePayload` gives back after a JSONB round-trip, so a
    // snapshot cannot look different before and after it is stored.
    const out: TemplatePayloadButton = {
      type: button.type,
      text: str(button.text) ?? '',
      url: null,
      phoneNumber: null,
      code: null,
    };
    switch (button.type) {
      case 'URL':
        // Meta's URL buttons carry their own {{1}} numbering, so the
        // send-time value substitutes into the template's own URL.
        out.url = override
          ? renderTemplateBody(button.url, [override])
          : button.url;
        break;
      case 'PHONE_NUMBER':
        out.phoneNumber = button.phone_number;
        break;
      case 'COPY_CODE':
        // The caller's override wins; otherwise the approved example is
        // what the recipient's copy button reveals.
        out.code = str(override) ?? str(button.example) ?? '';
        break;
      case 'QUICK_REPLY':
      case 'FLOW':
        // Label-only: neither carries a send-time value the thread
        // could show. A FLOW's destination lives inside Meta's client.
        break;
    }
    return out;
  });
}

/**
 * The snapshot itself. Split from `buildTemplatePayload` so the "is
 * there anything to record?" decision happens once instead of the body
 * being rendered twice — the substituted body is what the bubble shows,
 * so re-deriving it differently in two places would be a real bug.
 */
function composeTemplatePayload(
  args: BuildTemplatePayloadArgs,
): TemplateMessagePayload {
  const template = args.template ?? null;
  // A caller that rendered nothing (the public API, an automation) gets
  // the row's body with its own params substituted; with no params the
  // tokens stay visible, which is the same honesty rule as
  // renderTemplateBody — a blanked `{{1}}` would look like an empty
  // message rather than a missing value.
  const body =
    str(args.renderedBody) ??
    (template ? renderTemplateBody(template.body_text ?? '', args.bodyParams ?? []) : '');

  return {
    name: args.name,
    language: str(args.language) ?? str(template?.language) ?? 'en_US',
    category: str(template?.category),
    header: template ? buildHeader(template, args) : null,
    body,
    footer: str(template?.footer_text),
    buttons: template ? buildButtons(template, args) : [],
  };
}

/**
 * The snapshot for one delivered template, or `null` when there is
 * genuinely nothing to record — no local template row AND no rendered
 * body. Callers then store NULL and the bubble keeps its existing
 * text-only fallback, so a missing row never produces an empty bubble.
 */
export function buildTemplatePayload(
  args: BuildTemplatePayloadArgs,
): TemplateMessagePayload | null {
  const template = args.template ?? null;
  if (!template && !str(args.renderedBody)) return null;
  return composeTemplatePayload(args);
}

/**
 * Reconstruct a snapshot for a message written before migration 053
 * (no stored payload). The body is the text that was persisted at send
 * time — already substituted — while header/footer/buttons come from
 * the template as it stands today. That is the best available answer
 * for history; it is why new sends snapshot instead.
 */
export function payloadFromTemplateRow(
  template: MessageTemplate,
  opts: { name: string; language?: string | null; storedBody?: string | null },
): TemplateMessagePayload {
  return composeTemplatePayload({
    template,
    name: opts.name,
    language: opts.language ?? template.language,
    // Prefer the delivered text; fall back to the raw body (with its
    // {{n}} tokens visible) when the row stored nothing.
    renderedBody: str(opts.storedBody),
  });
}

// ------------------------------------------------------------
// Snapshot at a send site
// ------------------------------------------------------------

export interface SendSnapshotArgs {
  /** The local `message_templates` row the send resolved, if any. */
  template: MessageTemplate | null | undefined;
  name: string;
  language?: string | null;
  /**
   * Structured send-time params, exactly as the caller holds them
   * (`SendTimeParams` from a typed route, an `unknown` from a posted
   * body, or undefined). Read defensively — a caller that sent junk
   * still gets a snapshot from the template row alone.
   */
  messageParams?: unknown;
  /** Legacy positional body values, when the caller used that shape. */
  bodyParams?: string[] | null;
  /** The text about to be persisted as `messages.content_text`. */
  storedBody?: string | null;
}

/** Numeric-keyed button overrides out of an untrusted object. */
function coerceButtonParams(value: unknown): Record<number, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<number, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    if (typeof raw === 'string' && raw.trim()) out[index] = raw;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The snapshot to persist for a send that is about to be (or has just
 * been) handed to Meta. One function shared by every write site so a
 * dashboard send, a broadcast fan-out and an automation send cannot
 * record the same delivery three different ways.
 *
 * Returns `null` whenever there is no local `message_templates` row —
 * see the early exit below.
 */
export function buildSendTemplateSnapshot(
  args: SendSnapshotArgs,
): TemplateMessagePayload | null {
  // Without a row we cannot describe the header, footer or buttons, and
  // a body-only snapshot would be actively harmful: it duplicates
  // `content_text`, and because `resolveTemplateRender` prefers a stored
  // snapshot over reconstruction, it would permanently hide the full
  // delivery from a thread whose template is only synced LATER. Store
  // nothing; the text bubble renders either way, and a real snapshot (or
  // a reconstruction) becomes possible once the row exists.
  const template = args.template ?? null;
  if (!template) return null;

  const p =
    args.messageParams && typeof args.messageParams === 'object'
      ? (args.messageParams as {
          body?: unknown;
          headerText?: unknown;
          headerMediaUrl?: unknown;
          headerMediaId?: unknown;
          buttonParams?: unknown;
        })
      : {};

  const structuredBody = Array.isArray(p.body)
    ? p.body.filter((v): v is string => typeof v === 'string')
    : [];

  return buildTemplatePayload({
    template,
    name: args.name,
    language: args.language,
    // Structured wins, mirroring `templateBodyParams` and the wire
    // builder — what the bubble shows must be what Meta was given.
    bodyParams: structuredBody.length ? structuredBody : args.bodyParams,
    headerText: str(p.headerText),
    headerMediaUrl: str(p.headerMediaUrl),
    headerMediaId: str(p.headerMediaId),
    buttonParams: coerceButtonParams(p.buttonParams),
    renderedBody: str(args.storedBody),
  });
}

// ------------------------------------------------------------
// Deployment safety
// ------------------------------------------------------------

/**
 * True when a PostgREST error means "this column does not exist".
 *
 * Migration 053 adds `template_payload`, and code that writes it before
 * the SQL runs would otherwise fail the INSERT *after* Meta delivered —
 * the customer got the message and the thread shows nothing. Every write
 * site therefore retries without the snapshot when (and only when) the
 * database says the column is absent.
 */
export function isMissingColumnError(error: unknown, column: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  const message = typeof e.message === 'string' ? e.message : '';
  if (typeof e.code === 'string' && /(42703|PGRST204)$/.test(e.code)) return true;
  return message.includes(column) && /does not exist|not found|schema cache/i.test(message);
}

// ------------------------------------------------------------
// Reading a JSONB payload back
// ------------------------------------------------------------

const BUTTON_TYPES = [
  'QUICK_REPLY',
  'URL',
  'PHONE_NUMBER',
  'COPY_CODE',
  'FLOW',
] as const;

/**
 * Validate an arbitrary JSONB value into a payload. `template_payload`
 * is untyped at the database level, and one unexpected shape must not
 * take down the whole thread — an invalid value reads as "no snapshot"
 * and the bubble falls back to text, exactly like a legacy row.
 */
export function parseTemplatePayload(value: unknown): TemplateMessagePayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;

  if (typeof v.name !== 'string' || typeof v.body !== 'string') return null;

  const header = parseHeader(v.header);
  const buttons = parseButtons(v.buttons);

  return {
    name: v.name,
    language: typeof v.language === 'string' ? v.language : 'en_US',
    category: str(v.category),
    header,
    body: v.body,
    footer: str(v.footer),
    buttons,
  };
}

function parseHeader(value: unknown): TemplatePayloadHeader | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const kind = headerKind(typeof v.kind === 'string' ? v.kind : null);
  if (!kind) return null;
  return {
    kind,
    text: str(v.text),
    mediaUrl: str(v.mediaUrl),
    mediaId: str(v.mediaId),
    filename: str(v.filename),
  };
}

function parseButtons(value: unknown): TemplatePayloadButton[] {
  if (!Array.isArray(value)) return [];
  const out: TemplatePayloadButton[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const type = v.type;
    if (
      typeof type !== 'string' ||
      !(BUTTON_TYPES as readonly string[]).includes(type)
    ) {
      continue;
    }
    out.push({
      type: type as TemplatePayloadButton['type'],
      text: typeof v.text === 'string' ? v.text : '',
      url: str(v.url),
      phoneNumber: str(v.phoneNumber),
      code: str(v.code),
    });
  }
  return out;
}

/** Template names we can reconstruct history for, keyed by `name`. */
export type TemplateIndex = Map<string, MessageTemplate>;

/**
 * What the bubble should render for this message: the stored snapshot
 * when it exists, else a reconstruction from the live template, else
 * `null` (keep today's text-only bubble). Never throws on odd data.
 */
export function resolveTemplateRender(
  message: Message,
  index?: TemplateIndex,
): TemplateMessagePayload | null {
  const stored = parseTemplatePayload(
    (message as { template_payload?: unknown }).template_payload,
  );
  if (stored) return stored;

  const name = str(message.template_name);
  if (!name) return null;
  const row = index?.get(name) ?? index?.get(name.toLowerCase());
  if (!row) return null;

  return payloadFromTemplateRow(row, {
    name,
    storedBody: str(message.content_text),
  });
}

// ------------------------------------------------------------
// WhatsApp text markup
// ------------------------------------------------------------

/** One styled run of the delivered text. */
export interface MarkupToken {
  text: string;
  style: 'normal' | 'bold' | 'italic' | 'strike' | 'mono';
}

/**
 * `*bold*`, `_italic_`, `~strike~` and `` `mono` `` as WhatsApp renders
 * them. Meta only accepts these four, and a run must have something
 * between its delimiters and be free of line breaks — `.` is what
 * enforces the latter, so an unmatched `*` (very common in real bodies,
 * e.g. "*Contact : 9640…" wrapped over a line) stays literal instead of
 * bolding half the message. An empty run (`**`) is skipped too, leaving
 * the surrounding text untouched.
 */
const MARKUP_RE = /(\*.*?\*|_.*?_|~.*?~|`.*?`)/g;

export function splitWhatsAppMarkup(text: string): MarkupToken[] {
  if (!text) return [];
  const styleFor = (delim: string): MarkupToken['style'] =>
    delim === '*' ? 'bold' : delim === '_' ? 'italic' : delim === '~' ? 'strike' : 'mono';

  // Deliberately an exec loop rather than `text.split(MARKUP_RE)`:
  // splitting hands back every unmatched stretch too, and a stretch like
  // `*two` + newline + `lines*` starts and ends with `*` without ever
  // having matched — it would be styled as bold, quietly re-introducing
  // the "why are there asterisks in my bubble" confusion in reverse.
  const tokens: MarkupToken[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  MARKUP_RE.lastIndex = 0;
  while ((match = MARKUP_RE.exec(text)) !== null) {
    const inner = match[0].slice(1, -1);
    if (!inner) continue; // `**`, `__`, …: literal, not an empty run.
    if (match.index > cursor) {
      tokens.push({ text: text.slice(cursor, match.index), style: 'normal' });
    }
    tokens.push({ text: inner, style: styleFor(match[0][0]) });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor), style: 'normal' });
  return tokens;
}
