/**
 * Translate our local template row shape into the `components` array
 * shape that Meta's POST /{waba_id}/message_templates endpoint expects.
 *
 * Keep this function pure and JSON-shaped — the submit route and the
 * (future) edit route both call it, and unit tests assert the exact
 * payload by snapshot.
 *
 * Spec reference:
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components
 */

import type { TemplatePayload } from './template-validators';
import { buildCarouselCreationComponent } from './carousel';
import type { TemplateButton } from '@/types';

export interface MetaComponent {
  /**
   * CAROUSEL is the media-card-carousel component: no format, no text,
   * no buttons of its own — only nested `cards`.
   */
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS' | 'CAROUSEL';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text?: string;
  buttons?: MetaButtonPayload[];
  example?: {
    header_text?: string[];
    header_url?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
  /** CAROUSEL only — 2 to 10 cards, each a nested component list. */
  cards?: Array<{ components: MetaComponent[] }>;
}

export interface MetaButtonPayload {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'COPY_CODE' | 'FLOW';
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[];
  /** FLOW only — Meta's id of a *published* Flow. */
  flow_id?: string;
  /** FLOW only — `navigate` opens the Flow; `data_exchange` needs a prefill payload. */
  flow_action?: 'navigate' | 'data_exchange';
  /** FLOW only — screen to open. Required by Meta when flow_action is navigate. */
  navigate_screen?: string;
}

function buildHeaderComponent(payload: TemplatePayload): MetaComponent | null {
  const { header_type, header_content, header_media_url, header_handle } = payload;
  if (!header_type) return null;

  if (header_type === 'text') {
    const headerSample = payload.sample_values?.header;
    const component: MetaComponent = {
      type: 'HEADER',
      format: 'TEXT',
      text: header_content,
    };
    if (headerSample && headerSample.length > 0) {
      component.example = { header_text: headerSample };
    }
    return component;
  }

  const format =
    header_type === 'image'
      ? 'IMAGE'
      : header_type === 'video'
        ? 'VIDEO'
        : 'DOCUMENT';
  const component: MetaComponent = { type: 'HEADER', format };
  if (header_handle) {
    component.example = { header_handle: [header_handle] };
  } else if (header_media_url) {
    component.example = { header_url: [header_media_url] };
  }
  return component;
}

function buildBodyComponent(payload: TemplatePayload): MetaComponent {
  const component: MetaComponent = {
    type: 'BODY',
    text: payload.body_text,
  };
  const bodySample = payload.sample_values?.body;
  if (bodySample && bodySample.length > 0) {
    // Meta expects body_text as a 2D array — outer is "examples",
    // inner is the values for each variable. We submit a single
    // example row.
    component.example = { body_text: [bodySample] };
  }
  return component;
}

function buildFooterComponent(payload: TemplatePayload): MetaComponent | null {
  if (!payload.footer_text?.trim()) return null;
  return { type: 'FOOTER', text: payload.footer_text };
}

function buildButtonPayload(b: TemplateButton): MetaButtonPayload {
  switch (b.type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: b.text };
    case 'URL': {
      const payload: MetaButtonPayload = {
        type: 'URL',
        text: b.text,
        url: b.url,
      };
      if (b.example) payload.example = [b.example];
      return payload;
    }
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: b.text, example: [b.example] };
    case 'FLOW': {
      const payload: MetaButtonPayload = {
        type: 'FLOW',
        text: b.text,
        flow_id: b.flow_id,
        flow_action: 'navigate',
      };
      // Sent only when we actually have it: an empty `navigate_screen`
      // is a worse answer than an absent one (Meta errors on the value,
      // and the validator has already refused the submit for it).
      if (b.navigate_screen) payload.navigate_screen = b.navigate_screen;
      return payload;
    }
  }
}

function buildButtonsComponent(payload: TemplatePayload): MetaComponent | null {
  if (!payload.buttons || payload.buttons.length === 0) return null;
  return {
    type: 'BUTTONS',
    buttons: payload.buttons.map(buildButtonPayload),
  };
}

export interface MetaTemplateSubmitPayload {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  language: string;
  components: MetaComponent[];
}

const CATEGORY_TO_META: Record<
  'Marketing' | 'Utility' | 'Authentication',
  MetaTemplateSubmitPayload['category']
> = {
  Marketing: 'MARKETING',
  Utility: 'UTILITY',
  Authentication: 'AUTHENTICATION',
};

/**
 * Assemble the full submit payload (name + category + language +
 * components in canonical order: HEADER → BODY → FOOTER → BUTTONS).
 *
 * A carousel template is the exception the Meta docs spell out: it has
 * no header, no footer and no top-level buttons — only BODY followed by
 * CAROUSEL. The validators refuse any other combination, so the branch
 * below is the only place the carousel shape enters this builder.
 */
export function buildMetaTemplatePayload(
  payload: TemplatePayload,
): MetaTemplateSubmitPayload {
  const components: MetaComponent[] = [];
  const isCarousel = payload.header_type === 'carousel';
  const header = isCarousel ? null : buildHeaderComponent(payload);
  if (header) components.push(header);
  components.push(buildBodyComponent(payload));
  if (isCarousel && payload.carousel) {
    components.push(buildCarouselCreationComponent(payload.carousel));
    return {
      name: payload.name,
      category: CATEGORY_TO_META[payload.category],
      language: payload.language,
      components,
    };
  }
  const footer = buildFooterComponent(payload);
  if (footer) components.push(footer);
  const buttons = buildButtonsComponent(payload);
  if (buttons) components.push(buttons);

  return {
    name: payload.name,
    category: CATEGORY_TO_META[payload.category],
    language: payload.language,
    components,
  };
}
