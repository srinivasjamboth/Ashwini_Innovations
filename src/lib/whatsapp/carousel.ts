// ============================================================
// Media card carousels (Meta marketing templates).
//
// One module owns everything that is pure about a carousel: the JSON
// shape stored on `message_templates.carousel` (migration 059), the
// limits Meta documents, the validation both the builder and the submit
// route run, the creation component, the send component, the variable
// scopes a broadcast has to map, and the deterministic quick-reply
// payload that makes a tapped button traceable back to its card.
//
// Source of truth:
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/media-card-carousel-templates
//
// The rules that shape this file (all from the page above):
//   • Marketing category only; one body + one `carousel` component.
//   • 2–10 cards, FIXED at creation — every send must supply a value for
//     every card, with a zero-based `card_index`.
//   • Every card: an image or video header (required), optional body
//     text (≤160, and either ALL cards have it or none do), and up to
//     two buttons (quick reply / URL / phone).
//   • All cards share the media format and the same number, types and
//     ORDER of buttons. The builder therefore owns media format,
//     "cards have text" and the button layout as SHARED settings, so a
//     mismatched card cannot be constructed at all.
//   • A URL button carries at most one variable and it must be the last
//     thing in the URL.
//
// Deliberately conservative where the docs and reality may differ: a
// card must have at least one button here, because Meta's carousel
// documentation never shows a card without a `buttons` component even
// though it describes buttons as optional. Until a live create with zero
// buttons is confirmed to pass, the builder refuses it.
// ============================================================

import type {
  CarouselButtonKind,
  CarouselCard,
  CarouselCardButton,
  CarouselMediaFormat,
  CarouselTemplateData,
  MessageTemplate,
  TemplatePayloadButton,
  TemplatePayloadCard,
} from '@/types';

import type { MetaButtonPayload, MetaComponent } from './template-components';
import { MEDIA_HEADER_SPECS } from './media-header-types';
import {
  extractVariableIndices,
  TEMPLATE_LIMITS,
  type TemplatePayload,
} from './template-validators';

export const CAROUSEL_LIMITS = {
  minCards: 2,
  maxCards: 10,
  cardTextMaxLength: 160,
  /** Meta reuses the standard template button-label cap. */
  buttonLabelMaxLength: TEMPLATE_LIMITS.buttonTextMaxLength,
  urlMaxLength: 2000,
  phoneMaxLength: 20,
  maxButtonsPerCard: 2,
} as const;

/** Button kinds a carousel card may carry, in Meta's wire spellings. */
export const CAROUSEL_BUTTON_KINDS: readonly CarouselButtonKind[] = [
  'QUICK_REPLY',
  'URL',
  'PHONE_NUMBER',
];

const CARD_BUTTON_TYPE: Record<CarouselButtonKind, 'quick_reply' | 'url' | 'phone_number'> = {
  QUICK_REPLY: 'quick_reply',
  URL: 'url',
  PHONE_NUMBER: 'phone_number',
};

// ------------------------------------------------------------
// Construction
// ------------------------------------------------------------

export function emptyCarouselCard(): CarouselCard {
  return {
    media_url: null,
    media_handle: null,
    media_filename: null,
    media_size: null,
    text: '',
    text_examples: [],
    buttons: [],
  };
}

/**
 * A new carousel: two image cards, text on, and one quick reply per
 * card. Every shared setting has a legal value on day one, so the
 * "compliant by construction" rule holds before the author touches
 * anything.
 */
export function defaultCarouselData(): CarouselTemplateData {
  const button_layout: CarouselTemplateData['button_layout'] = [{ type: 'QUICK_REPLY' }];
  return {
    media_format: 'image',
    cards_have_text: true,
    button_layout,
    // Card buttons derive from the layout here too — the same rule
    // applyButtonLayout and the editor's addCard follow — so a fresh
    // carousel never starts with the "buttons do not match the shared
    // layout" issue, and the only day-one problems are the ones the
    // author can actually fix (media, text, button labels).
    cards: [emptyCarouselCard(), emptyCarouselCard()].map((card) => ({
      ...card,
      buttons: button_layout.map((item) => ({ type: item.type, text: '' })),
    })),
  };
}

/**
 * Apply a shared button layout to every card. Card buttons are always
 * derived from the layout — an author edits each card's labels, URL and
 * number, never its button count or order — which is what makes a
 * mismatched card impossible.
 *
 * A slot whose TYPE changed is re-typed in place on every card: the
 * label carries over (it usually still describes the action), but the
 * url / phone values of the previous type are dropped — keeping the old
 * button object left cards stuck on the previous type, which hid the
 * URL / phone fields and reported a layout mismatch.
 */
export function applyButtonLayout(
  data: CarouselTemplateData,
  layout: CarouselButtonKind[],
): CarouselTemplateData {
  const next = layout.map((type) => ({ type }));
  return {
    ...data,
    button_layout: next,
    cards: data.cards.map((card) => ({
      ...card,
      buttons: next.map((item, i) => {
        const existing = card.buttons[i];
        if (!existing) return { type: item.type, text: '' };
        if (existing.type === item.type) return existing;
        return { type: item.type, text: existing.text };
      }),
    })),
  };
}

// ------------------------------------------------------------
// Reading untrusted JSON
// ------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseCarouselButton(value: unknown): CarouselCardButton | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const type = typeof v.type === 'string' ? v.type.toUpperCase() : '';
  if (!CAROUSEL_BUTTON_KINDS.includes(type as CarouselButtonKind)) return null;
  return {
    type: type as CarouselButtonKind,
    text: asString(v.text) ?? '',
    url: asString(v.url),
    url_example: asString(v.url_example),
    phone_number: asString(v.phone_number),
  };
}

function parseCarouselCard(value: unknown): CarouselCard | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const buttons = Array.isArray(v.buttons)
    ? v.buttons.map(parseCarouselButton).filter((b): b is CarouselCardButton => b !== null)
    : [];
  return {
    media_url: asString(v.media_url),
    media_handle: asString(v.media_handle),
    media_filename: asString(v.media_filename),
    media_size: typeof v.media_size === 'number' ? v.media_size : null,
    text: asString(v.text) ?? '',
    text_examples: Array.isArray(v.text_examples)
      ? v.text_examples.filter((s): s is string => typeof s === 'string')
      : [],
    buttons,
  };
}

/**
 * Turn whatever is in the JSONB column into a carousel, or `null`.
 *
 * Never throws: a hand-edited row, a partially-synced template or a
 * future shape must degrade to "this template has no readable cards",
 * which every consumer already handles — the same rule
 * `parseTemplatePayload` follows for message snapshots.
 */
export function parseCarousel(value: unknown): CarouselTemplateData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;

  const mediaFormat = typeof v.media_format === 'string' ? v.media_format.toLowerCase() : '';
  if (mediaFormat !== 'image' && mediaFormat !== 'video') return null;

  if (!Array.isArray(v.cards) || v.cards.length === 0) return null;
  const cards = v.cards.map(parseCarouselCard).filter((c): c is CarouselCard => c !== null);
  if (cards.length === 0) return null;

  const layout = Array.isArray(v.button_layout)
    ? v.button_layout.map((item) => {
        if (typeof item === 'string') return item.toUpperCase();
        if (item && typeof item === 'object') {
          const t = (item as { type?: unknown }).type;
          if (typeof t === 'string') return t.toUpperCase();
        }
        return '';
      }).filter((t): t is CarouselButtonKind =>
        CAROUSEL_BUTTON_KINDS.includes(t as CarouselButtonKind),
      )
    : [];

  return {
    media_format: mediaFormat as CarouselMediaFormat,
    cards_have_text: v.cards_have_text === true,
    button_layout: layout.map((type) => ({ type })),
    cards,
  };
}

/** The row's carousel, when it has one. Ignores non-carousel templates. */
export function carouselOf(
  template: Pick<MessageTemplate, 'header_type' | 'carousel'> | null | undefined,
): CarouselTemplateData | null {
  if (!template || template.header_type !== 'carousel') return null;
  return parseCarousel(template.carousel);
}

// ------------------------------------------------------------
// Validation (shared by the builder and the submit route)
// ------------------------------------------------------------

export interface CarouselIssue {
  message: string;
  /** Which card the problem belongs to; null for a template-level issue. */
  cardIndex: number | null;
}

/**
 * Meta's one-variable-at-the-end rule for a carousel URL button. Returns
 * the offending reason, or null when the URL is acceptable.
 */
export function carouselUrlIssue(url: string): string | null {
  if (!url.trim()) return 'URL is required.';
  let parsed: URL;
  try {
    // Strip the token before parsing: `https://x.test/{{1}}` is a valid
    // template URL but `new URL` rejects nothing there, so this is about
    // the scheme/host, not the variable.
    parsed = new URL(url.replace(/\{\{\d+\}\}/g, 'x'));
  } catch {
    return 'URL is not valid.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'URL must start with http:// or https://.';
  }
  if (url.length > CAROUSEL_LIMITS.urlMaxLength) {
    return `URL exceeds ${CAROUSEL_LIMITS.urlMaxLength} characters.`;
  }
  const vars = extractVariableIndices(url);
  if (vars.length > 1) return 'URL supports at most one variable (Meta rule).';
  if (vars.length === 1) {
    if (vars[0] !== 1) return 'URL variable must be {{1}} (Meta rule).';
    if (!/\{\{1\}\}$/.test(url)) {
      return 'URL variable must be at the very end of the URL (Meta rule).';
    }
  }
  return null;
}

/** True when a card is missing anything it needs — drives the red dot. */
export function isCarouselCardComplete(
  data: CarouselTemplateData,
  card: CarouselCard,
  index: number,
): boolean {
  return collectCardIssues(data, card, index).length === 0;
}

/**
 * Extension aliases Meta accepts for media headers. The stored object
 * keeps the uploaded file's original extension, so `photo.jpeg` must
 * validate as the same JPEG the spec names `jpg` — treating `.jpeg` as
 * a wrong format was falsely blocking a perfectly good image (and
 * keeping Submit disabled).
 */
const MEDIA_EXT_ALIASES: Record<string, string> = {
  jpeg: 'jpg',
  jpe: 'jpg',
  '3gpp': '3gp',
};

/** Lowercase extension of a media URL's last path segment, '' when it has none. */
function carouselMediaExt(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0];
  const lastSegment = withoutQuery.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot < 0) return '';
  const raw = lastSegment.slice(dot + 1).toLowerCase();
  // A real extension is a short alphanumeric tail; anything else (a
  // dotless host/path leaking through) is treated as "no extension".
  return /^[a-z0-9]{1,5}$/.test(raw) ? raw : '';
}

/** Every extension accepted for a media format, aliases included. */
function allowedExtensions(spec: typeof MEDIA_HEADER_SPECS.image): string[] {
  const base = Object.values(spec.extensions) as string[];
  const out = new Set<string>(base);
  for (const [alias, canonical] of Object.entries(MEDIA_EXT_ALIASES)) {
    if (base.includes(canonical)) out.add(alias);
  }
  return [...out];
}

function collectCardIssues(
  data: CarouselTemplateData,
  card: CarouselCard,
  index: number,
): CarouselIssue[] {
  const out: CarouselIssue[] = [];
  const label = `Card ${index + 1}`;

  if (!card.media_url?.trim() && !card.media_handle?.trim()) {
    out.push({ cardIndex: index, message: `${label} has no ${data.media_format} asset.` });
  } else if (card.media_url?.trim()) {
    // A card can only be the shared format; the builder enforces it at
    // upload time, and this catches a hand-edited row before Meta does.
    const expected = MEDIA_HEADER_SPECS[data.media_format];
    const ext = carouselMediaExt(card.media_url);
    // Only judge URLs that actually carry a extension; a link with none
    // (a bare CDN path, a redirect) is left for Meta to vet rather than
    // falsely rejected here.
    if (ext && !allowedExtensions(expected).includes(ext) && !card.media_handle) {
      out.push({
        cardIndex: index,
        message: `${label}'s asset is not ${expected.formats}, the format the other cards use.`,
      });
    }
  }

  if (data.cards_have_text) {
    const text = card.text ?? '';
    if (!text.trim()) {
      out.push({ cardIndex: index, message: `${label} has no card text, but the carousel is set to put text on every card.` });
    } else if (text.length > CAROUSEL_LIMITS.cardTextMaxLength) {
      out.push({
        cardIndex: index,
        message: `${label} text exceeds ${CAROUSEL_LIMITS.cardTextMaxLength} characters (got ${text.length}).`,
      });
    } else {
      const vars = extractVariableIndices(text);
      for (let i = 0; i < vars.length; i++) {
        if (vars[i] !== i + 1) {
          out.push({
            cardIndex: index,
            message: `${label} text variables must be contiguous starting at {{1}}.`,
          });
          break;
        }
      }
      const examples = card.text_examples ?? [];
      if (examples.length !== vars.length) {
        out.push({
          cardIndex: index,
          message: `${label} text has ${vars.length} variable(s) — supply exactly ${vars.length} sample value(s).`,
        });
      } else if (examples.some((e) => !e?.trim())) {
        out.push({ cardIndex: index, message: `${label} has an empty sample value.` });
      }
    }
  }

  if (card.buttons.length < 1) {
    out.push({ cardIndex: index, message: `${label} needs at least one button.` });
  }
  card.buttons.forEach((button, b) => {
    const which = `${label} button ${b + 1}`;
    if (!button.text?.trim()) {
      out.push({ cardIndex: index, message: `${which} has no label.` });
    } else if (button.text.length > CAROUSEL_LIMITS.buttonLabelMaxLength) {
      out.push({
        cardIndex: index,
        message: `${which} label exceeds ${CAROUSEL_LIMITS.buttonLabelMaxLength} characters.`,
      });
    }
    if (button.type === 'URL') {
      const issue = carouselUrlIssue(button.url ?? '');
      if (issue) out.push({ cardIndex: index, message: `${which}: ${issue}` });
      if (/\{\{1\}\}/.test(button.url ?? '') && !button.url_example?.trim()) {
        out.push({ cardIndex: index, message: `${which} uses a variable — Meta requires a sample value.` });
      }
    }
    if (button.type === 'PHONE_NUMBER') {
      const phone = (button.phone_number ?? '').trim();
      if (!phone) {
        out.push({ cardIndex: index, message: `${which} has no phone number.` });
      } else if (!/^\+?\d{6,20}$/.test(phone.replace(/[\s()-]/g, ''))) {
        out.push({ cardIndex: index, message: `${which} phone number must be digits with a country code.` });
      } else if (phone.length > CAROUSEL_LIMITS.phoneMaxLength) {
        out.push({
          cardIndex: index,
          message: `${which} phone number exceeds ${CAROUSEL_LIMITS.phoneMaxLength} characters.`,
        });
      }
    }
  });

  return out;
}

/**
 * Every problem with the carousel, template-level first then per card in
 * order. The builder lists these verbatim and links each one to its
 * card, so this must stay the single source both client and server use.
 */
export function collectCarouselIssues(data: CarouselTemplateData): CarouselIssue[] {
  const out: CarouselIssue[] = [];

  if (data.cards.length < CAROUSEL_LIMITS.minCards) {
    out.push({
      cardIndex: null,
      message: `A carousel needs at least ${CAROUSEL_LIMITS.minCards} cards (got ${data.cards.length}).`,
    });
  }
  if (data.cards.length > CAROUSEL_LIMITS.maxCards) {
    out.push({
      cardIndex: null,
      message: `A carousel can hold at most ${CAROUSEL_LIMITS.maxCards} cards (got ${data.cards.length}).`,
    });
  }

  // Shared layout sanity — the builder keeps these in sync, so a break
  // here means a hand-edited or badly synced document.
  if (data.button_layout.length < 1) {
    out.push({ cardIndex: null, message: 'Choose the button layout for the cards.' });
  }
  if (data.button_layout.length > CAROUSEL_LIMITS.maxButtonsPerCard) {
    out.push({
      cardIndex: null,
      message: `A card carries at most ${CAROUSEL_LIMITS.maxButtonsPerCard} buttons.`,
    });
  }
  // Meta's non-interleaving rule, applied to the shared layout.
  let sawNonQuick = false;
  for (const item of data.button_layout) {
    if (item.type === 'QUICK_REPLY') {
      if (sawNonQuick) {
        out.push({
          cardIndex: null,
          message: 'Quick reply buttons must come before URL and phone number buttons.',
        });
        break;
      }
    } else {
      sawNonQuick = true;
    }
  }

  data.cards.forEach((card, index) => {
    const expected = data.button_layout.map((b) => b.type);
    const actual = card.buttons.map((b) => b.type);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      out.push({
        cardIndex: index,
        message: `Card ${index + 1}'s buttons do not match the shared layout — every card must carry the same buttons in the same order.`,
      });
      // Still worth reporting the card's own field problems.
    }
    out.push(...collectCardIssues(data, card, index));
  });

  return out;
}

export function isCarouselValid(data: CarouselTemplateData | null): boolean {
  if (!data) return false;
  return collectCarouselIssues(data).length === 0;
}

/**
 * The carousel half of a template submission. `validateTemplatePayload`
 * deliberately knows nothing about cards (it only skips the header and
 * footer rules that do not apply here), so this is the single gate for
 * everything Meta's carousel docs add on top:
 *
 *   • Marketing category only — Utility/Authentication carousels are
 *     rejected by Meta with an opaque error.
 *   • No top-level footer and no top-level buttons; the buttons live on
 *     the cards.
 *   • No single header asset; every card carries its own.
 *   • Every card rule from `collectCarouselIssues`.
 *
 * A no-op for a non-carousel payload, so both submit routes can call it
 * unconditionally and existing templates keep the exact behaviour they
 * had before this feature existed.
 */
export function validateCarouselSubmission(payload: TemplatePayload): void {
  if (payload.header_type !== 'carousel') return;

  if (payload.category !== 'Marketing') {
    throw new Error('Carousel templates must use the Marketing category (Meta rule).');
  }
  if (payload.footer_text?.trim()) {
    throw new Error('A carousel template has no footer — the cards replace it (Meta rule).');
  }
  if (payload.buttons?.length) {
    throw new Error(
      'A carousel template has no top-level buttons — add buttons to the cards instead (Meta rule).',
    );
  }
  if (payload.header_content?.trim() || payload.header_media_url?.trim() || payload.header_handle?.trim()) {
    throw new Error('A carousel template has no header asset of its own — each card has one.');
  }

  const data = parseCarousel(payload.carousel);
  if (!data) throw new Error('Carousel templates need at least one card. Add cards in the carousel editor.');

  const issues = collectCarouselIssues(data);
  if (issues.length > 0) {
    // Same first-failure contract as every other validator here; the
    // builder shows the full list, the API returns the head of it.
    throw new Error(issues[0].message);
  }
}

// ------------------------------------------------------------
// Variable scopes (broadcast mapping + sample values)
// ------------------------------------------------------------

export interface CarouselScope {
  /** Stable key stored in `broadcasts.template_variables`. */
  key: string;
  /** Human label, e.g. "Card 2 text 1". */
  label: string;
  cardIndex: number;
  kind: 'cardText' | 'cardUrl';
  /** 1-based variable position inside that card's component. */
  varIndex: number;
  /** The template's own sample value, as the mapping placeholder hint. */
  sample: string;
}

/**
 * Every per-recipient slot a carousel needs filled: each card's text
 * variables and each URL button's trailing variable. Message-body
 * variables are NOT included — the broadcast already maps those by their
 * plain numeric key, and keeping the two key spaces apart is what lets
 * old campaigns resolve unchanged.
 */
export function carouselScopes(data: CarouselTemplateData): CarouselScope[] {
  const out: CarouselScope[] = [];
  data.cards.forEach((card, cardIndex) => {
    if (data.cards_have_text) {
      const vars = extractVariableIndices(card.text ?? '');
      vars.forEach((n) => {
        out.push({
          key: `card.${cardIndex}.text.${n}`,
          label: `Card ${cardIndex + 1} text ${n}`,
          cardIndex,
          kind: 'cardText',
          varIndex: n,
          sample: card.text_examples?.[n - 1] ?? '',
        });
      });
    }
    card.buttons.forEach((button, buttonIndex) => {
      if (button.type !== 'URL') return;
      if (!/\{\{1\}\}/.test(button.url ?? '')) return;
      out.push({
        key: `card.${cardIndex}.button.${buttonIndex}.url`,
        label: `Card ${cardIndex + 1} URL button`,
        cardIndex,
        kind: 'cardUrl',
        varIndex: 1,
        sample: button.url_example ?? '',
      });
    });
  });
  return out;
}

// ------------------------------------------------------------
// Creation component
// ------------------------------------------------------------

function buildCardButtons(card: CarouselCard): MetaComponent {
  return {
    type: 'BUTTONS',
    buttons: card.buttons.map((button) => {
      const out: MetaButtonPayload = {
        type: CARD_BUTTON_TYPE[button.type].toUpperCase() as MetaButtonPayload['type'],
        text: button.text,
      };
      if (button.type === 'URL') {
        out.url = button.url ?? undefined;
        if (button.url_example) out.example = [button.url_example];
      }
      if (button.type === 'PHONE_NUMBER') out.phone_number = button.phone_number ?? undefined;
      return out;
    }),
  };
}

/**
 * The `CAROUSEL` component for POST /{waba_id}/message_templates.
 *
 * Card headers are always sent as `example.header_handle` — Meta does
 * not accept a public URL for a carousel card sample, exactly as for a
 * media template header. `ensureCarouselCardHandles` fills any missing
 * handle before this runs.
 *
 * A card's text is submitted in the same shape as a template body
 * (`type: 'BODY'` + `example.body_text`). Meta's carousel page describes
 * card text but its creation example never shows the component, so this
 * mirrors the body syntax the API already accepts everywhere else; if a
 * live create disagrees, the sync path re-reads whatever Meta stores.
 */
export function buildCarouselCreationComponent(data: CarouselTemplateData): MetaComponent {
  const format = data.media_format.toUpperCase() as 'IMAGE' | 'VIDEO';
  return {
    type: 'CAROUSEL',
    cards: data.cards.map((card) => {
      const components: MetaComponent[] = [
        {
          type: 'HEADER',
          format,
          example: { header_handle: [card.media_handle ?? ''] },
        },
      ];
      if (data.cards_have_text) {
        const examples = card.text_examples ?? [];
        components.push({
          type: 'BODY',
          text: card.text ?? '',
          ...(examples.length ? { example: { body_text: [examples] } } : {}),
        });
      }
      components.push(buildCardButtons(card));
      return { components };
    }),
  };
}

/**
 * Sync-side reverse: Meta's carousel component (either case, either the
 * create-shape or the read-back shape) into our card document. Media
 * urls are filled later by the caller from the mirrored sample, the
 * same way a media header's URL is recovered — a handle is not
 * renderable.
 */
export function carouselFromMetaComponent(
  component: unknown,
  existing: CarouselTemplateData | null,
): CarouselTemplateData | null {
  if (!component || typeof component !== 'object') return null;
  const v = component as Record<string, unknown>;
  if (String(v.type ?? '').toUpperCase() !== 'CAROUSEL') return null;
  const rawCards = Array.isArray(v.cards) ? v.cards : null;
  if (!rawCards || rawCards.length === 0) return null;

  let sawVideo = false;
  const cards: CarouselCard[] = rawCards.map((rawCard, index) => {
    const components = componentsOf(rawCard);
    const header = components.find((c) => c.type === 'HEADER');
    const body = components.find((c) => c.type === 'BODY');
    const buttonsComponent = components.find((c) => c.type === 'BUTTONS');
    const previous = existing?.cards[index];

    if (String(header?.format ?? '').toUpperCase() === 'VIDEO') sawVideo = true;

    const rawButtons = Array.isArray(buttonsComponent?.buttons)
      ? (buttonsComponent?.buttons as unknown[])
      : [];
    const example = (body?.example ?? {}) as Record<string, unknown>;
    const bodyText = Array.isArray(example.body_text) ? example.body_text : [];
    const firstExample = Array.isArray(bodyText[0]) ? (bodyText[0] as unknown[]) : [];

    return {
      // Meta's read-back carries no asset URL, so keep ours when this
      // template was already synced from the builder.
      media_url: previous?.media_url ?? null,
      media_handle: firstString(headerHandleOf(header)) ?? previous?.media_handle ?? null,
      media_filename: previous?.media_filename ?? null,
      media_size: previous?.media_size ?? null,
      text: typeof body?.text === 'string' ? body.text : (previous?.text ?? ''),
      text_examples: firstExample.length
        ? firstExample.filter((s): s is string => typeof s === 'string')
        : (previous?.text_examples ?? []),
      buttons: rawButtons.map(normalizeMetaCardButton),
    };
  });

  return {
    media_format: sawVideo ? 'video' : 'image',
    cards_have_text: cards.some((c) => Boolean(c.text?.trim())),
    button_layout: cards[0]?.buttons.map((b) => ({ type: b.type })) ?? [],
    cards,
  };
}

function headerHandleOf(header: Record<string, unknown> | undefined): unknown {
  const example = header?.example;
  if (!example || typeof example !== 'object') return undefined;
  return (example as Record<string, unknown>).header_handle;
}

function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first = value.find((s) => typeof s === 'string' && s.length > 0);
  return typeof first === 'string' ? first : null;
}

function componentsOf(rawCard: unknown): Array<Record<string, unknown>> {
  if (!rawCard || typeof rawCard !== 'object') return [];
  const components = (rawCard as { components?: unknown }).components;
  return Array.isArray(components)
    ? components.map((c) => ({
        ...c,
        type: String((c as { type?: unknown })?.type ?? '').toUpperCase(),
      }))
    : [];
}

function normalizeMetaCardButton(raw: unknown): CarouselCardButton {
  const v = (raw ?? {}) as Record<string, unknown>;
  const type = String(v.type ?? '').toUpperCase();
  const kind: CarouselButtonKind =
    type === 'URL' ? 'URL' : type === 'PHONE_NUMBER' ? 'PHONE_NUMBER' : 'QUICK_REPLY';
  return {
    type: kind,
    text: typeof v.text === 'string' ? v.text : '',
    url: typeof v.url === 'string' ? v.url : null,
    url_example: Array.isArray(v.example) ? String(v.example[0] ?? '') : null,
    phone_number: typeof v.phone_number === 'string' ? v.phone_number : null,
  };
}

// ------------------------------------------------------------
// Send component
// ------------------------------------------------------------

/** Per-recipient card values, frozen on `broadcast_recipients.carousel_params`. */
export interface CarouselSendValues {
  cards: Array<{
    /** Values for the card text {{1}}, {{2}}… in order. */
    text?: string[];
    /** Value for a URL button's trailing {{1}}, keyed by button index. */
    buttonUrls?: Record<number, string>;
  }>;
  /**
   * Resolved card media, parallel to `cards`. Media is uploaded once per
   * campaign per phone number, so this is campaign-level while the text
   * and URL values are per-recipient.
   */
  media?: Array<{ id?: string; link?: string }>;
}

/**
 * Read `CarouselSendValues` out of an untrusted value — the
 * `broadcast_recipients.carousel_params` JSONB column on a Resume, or a
 * caller-supplied `messageParams.carousel`. Never throws: junk degrades
 * to `null` ("no per-recipient values") exactly like `parseCarousel`
 * degrades a bad template document, so a corrupt row can't crash a
 * fan-out or a snapshot.
 */
export function parseCarouselSendValues(value: unknown): CarouselSendValues | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { cards?: unknown; media?: unknown };
  const out: CarouselSendValues = { cards: [] };
  if (Array.isArray(v.cards)) {
    out.cards = v.cards.map((raw) => {
      const c = (raw ?? {}) as { text?: unknown; buttonUrls?: unknown };
      const entry: CarouselSendValues['cards'][number] = {};
      if (Array.isArray(c.text)) {
        entry.text = c.text.map((t) => (typeof t === 'string' ? t : String(t ?? '')));
      }
      if (
        c.buttonUrls &&
        typeof c.buttonUrls === 'object' &&
        !Array.isArray(c.buttonUrls)
      ) {
        const urls: Record<number, string> = {};
        for (const [key, rawUrl] of Object.entries(c.buttonUrls as Record<string, unknown>)) {
          const index = Number(key);
          if (!Number.isInteger(index) || index < 0) continue;
          if (typeof rawUrl === 'string' && rawUrl.trim()) urls[index] = rawUrl;
        }
        if (Object.keys(urls).length) entry.buttonUrls = urls;
      }
      return entry;
    });
  }
  if (Array.isArray(v.media)) {
    out.media = v.media.map((raw) => {
      const m = (raw ?? {}) as { id?: unknown; link?: unknown };
      return {
        ...(typeof m.id === 'string' ? { id: m.id } : {}),
        ...(typeof m.link === 'string' ? { link: m.link } : {}),
      };
    });
  }
  return out.cards.length || out.media?.length ? out : null;
}

/**
 * Deterministic quick-reply payload: `tpl:<template id>:card:<n>:btn:<n>`.
 * Meta echoes it in `messages.button.payload` when the customer taps, so
 * the inbound webhook can attribute a reply to the exact card without
 * the label having to stay unique.
 */
export function carouselQuickReplyPayload(
  templateId: string,
  cardIndex: number,
  buttonIndex: number,
): string {
  return `tpl:${templateId}:card:${cardIndex}:btn:${buttonIndex}`;
}

export interface CarouselSendComponent {
  type: 'carousel';
  cards: Array<{
    card_index: number;
    components: Array<Record<string, unknown>>;
  }>;
}

/**
 * The `carousel` send component for POST /{phone_number_id}/messages.
 *
 * Meta requires a card for EVERY card on the template, in order, with a
 * zero-based `card_index`, and the button components must match the
 * template's button types and order — so this walks the template's own
 * layout rather than whatever the caller happened to supply.
 *
 * A missing value throws rather than sending an empty parameter, which
 * Meta would reject with a message that names no card.
 */
export function buildCarouselSendComponent(
  data: CarouselTemplateData,
  templateId: string,
  values: CarouselSendValues | undefined,
): CarouselSendComponent {
  const cards = data.cards.map((card, cardIndex) => {
    const perCard = values?.cards?.[cardIndex] ?? {};
    const components: Array<Record<string, unknown>> = [];

    const media = values?.media?.[cardIndex];
    if (!media?.id && !media?.link) {
      throw new Error(
        `Card ${cardIndex + 1} needs its ${data.media_format} uploaded before sending.`,
      );
    }
    components.push({
      type: 'header',
      parameters: [
        {
          type: data.media_format,
          [data.media_format]: media.id ? { id: media.id } : { link: media.link },
        },
      ],
    });

    if (data.cards_have_text) {
      const varCount = extractVariableIndices(card.text ?? '').length;
      const supplied = perCard.text ?? [];
      if (varCount > 0) {
        if (supplied.length < varCount) {
          throw new Error(
            `Card ${cardIndex + 1} text has ${varCount} variable(s) but only ${supplied.length} value(s) were supplied.`,
          );
        }
        components.push({
          type: 'body',
          parameters: supplied.slice(0, varCount).map((text) => ({ type: 'text', text: String(text) })),
        });
      }
      // A card with static text and no variables needs no body component —
      // Meta fills it from the approved template.
    }

    card.buttons.forEach((button, buttonIndex) => {
      if (button.type === 'QUICK_REPLY') {
        components.push({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(buttonIndex),
          parameters: [
            { type: 'payload', payload: carouselQuickReplyPayload(templateId, cardIndex, buttonIndex) },
          ],
        });
        return;
      }
      if (button.type === 'URL' && /\{\{1\}\}/.test(button.url ?? '')) {
        const value = perCard.buttonUrls?.[buttonIndex];
        if (!value || !value.trim()) {
          throw new Error(
            `Card ${cardIndex + 1} URL button ${buttonIndex + 1} uses a variable — a value is required.`,
          );
        }
        components.push({
          type: 'button',
          sub_type: 'url',
          index: String(buttonIndex),
          parameters: [{ type: 'text', text: value }],
        });
      }
      // A static URL button and a phone number button carry no send-time
      // parameter: Meta reads them off the approved template.
    });

    return { card_index: cardIndex, components };
  });

  return { type: 'carousel', cards };
}

// ------------------------------------------------------------
// Delivery snapshot
// ------------------------------------------------------------

/**
 * The card row to store on `messages.template_payload` so the thread
 * shows what this recipient received. Media comes from the durable URL
 * we own (never a Meta id — the bubble cannot render one) and every
 * variable is substituted here, matching the honesty rule the rest of
 * `template-render.ts` follows: an unfilled token stays visible rather
 * than becoming a blank.
 */
export function buildCarouselSnapshotCards(
  data: CarouselTemplateData,
  values: CarouselSendValues | undefined,
): TemplatePayloadCard[] {
  return data.cards.map((card, cardIndex) => {
    const perCard = values?.cards?.[cardIndex] ?? {};
    const textValues = perCard.text ?? [];
    let text: string | null = null;
    if (data.cards_have_text) {
      text = (card.text ?? '').replace(/\{\{(\d+)\}\}/g, (raw, n) => {
        const value = textValues[Number(n) - 1];
        return value ? String(value) : raw;
      });
    }
    const buttons: TemplatePayloadButton[] = card.buttons.map((button, buttonIndex) => {
      const out: TemplatePayloadButton = {
        type: button.type,
        text: button.text ?? '',
        url: null,
        phoneNumber: null,
        code: null,
      };
      if (button.type === 'URL') {
        const value = perCard.buttonUrls?.[buttonIndex];
        out.url = (button.url ?? '').replace(/\{\{1\}\}/g, value ? String(value) : '{{1}}');
      }
      if (button.type === 'PHONE_NUMBER') out.phoneNumber = button.phone_number ?? null;
      return out;
    });
    return {
      index: cardIndex,
      kind: data.media_format,
      mediaUrl: card.media_url ?? null,
      text,
      buttons,
    };
  });
}

/** Substitute a card text's variables from the template's own samples. */
export function carouselCardPreviewText(card: CarouselCard): string {
  const examples = card.text_examples ?? [];
  return (card.text ?? '').replace(/\{\{(\d+)\}\}/g, (raw, n) => {
    const value = examples[Number(n) - 1]?.trim();
    return value ? value : raw;
  });
}
