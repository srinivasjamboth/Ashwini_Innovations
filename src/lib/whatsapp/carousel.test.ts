import { describe, expect, it } from 'vitest';

import type { CarouselCard, CarouselTemplateData } from '@/types';

import {
  CAROUSEL_LIMITS,
  applyButtonLayout,
  buildCarouselCreationComponent,
  buildCarouselSendComponent,
  buildCarouselSnapshotCards,
  carouselFromMetaComponent,
  carouselOf,
  carouselQuickReplyPayload,
  carouselScopes,
  carouselUrlIssue,
  collectCarouselIssues,
  defaultCarouselData,
  emptyCarouselCard,
  isCarouselCardComplete,
  isCarouselValid,
  parseCarousel,
  parseCarouselSendValues,
  validateCarouselSubmission,
  type CarouselSendValues,
} from './carousel';
import type { TemplatePayload } from './template-validators';

// ------------------------------------------------------------
// Carousel feature coverage (media-card carousels build).
// Pure functions only — the same module the builder and the
// server submit/send paths share, so these tests pin the
// validation matrix and both Meta payload shapes.
// ------------------------------------------------------------

function makeCard(over: Partial<CarouselCard> = {}): CarouselCard {
  return {
    ...emptyCarouselCard(),
    media_url: 'https://cdn.test/card.jpg',
    media_handle: 'handle-1',
    text: 'Hi {{1}}',
    text_examples: ['there'],
    buttons: [
      { type: 'QUICK_REPLY', text: 'Buy', url: null, url_example: null, phone_number: null },
    ],
    ...over,
  };
}

/** A fully valid 3-image-card carousel — the PART 6 scenario shape. */
function validData(): CarouselTemplateData {
  return {
    media_format: 'image',
    cards_have_text: true,
    button_layout: [{ type: 'QUICK_REPLY' }],
    cards: [makeCard(), makeCard(), makeCard()],
  };
}

function withCards(data: CarouselTemplateData, cards: CarouselCard[]): CarouselTemplateData {
  return { ...data, cards };
}

describe('defaultCarouselData / applyButtonLayout', () => {
  it('starts compliant: 2 image cards, text on, one quick reply', () => {
    const data = defaultCarouselData();
    expect(data.cards).toHaveLength(2);
    expect(data.media_format).toBe('image');
    expect(data.cards_have_text).toBe(true);
    expect(data.button_layout).toEqual([{ type: 'QUICK_REPLY' }]);
    // A brand-new carousel must not report "buttons do not match the
    // shared layout" — the cards' buttons start derived from the layout.
    for (const card of data.cards) {
      expect(card.buttons.map((b) => b.type)).toEqual(['QUICK_REPLY']);
    }
    const open = collectCarouselIssues(data).map((i) => i.message);
    expect(open.some((m) => /do not match the shared layout/.test(m))).toBe(false);
    expect(open.some((m) => /needs at least one button/.test(m))).toBe(false);
  });

  it('re-applies the shared layout to every card, so cards cannot drift', () => {
    const data = withCards(validData(), [
      makeCard(),
      makeCard(),
      makeCard(),
    ]);
    const next = applyButtonLayout(data, ['QUICK_REPLY', 'URL']);
    expect(next.cards).toHaveLength(3);
    for (const card of next.cards) {
      expect(card.buttons.map((b) => b.type)).toEqual(['QUICK_REPLY', 'URL']);
    }
  });
});

describe('collectCarouselIssues — the validation matrix', () => {
  it('accepts a well-formed carousel', () => {
    expect(collectCarouselIssues(validData())).toEqual([]);
    expect(isCarouselValid(validData())).toBe(true);
  });

  it('rejects fewer than 2 / more than 10 cards', () => {
    const one = withCards(validData(), [makeCard()]);
    expect(collectCarouselIssues(one)[0]?.message).toMatch(/at least 2 cards/);
    const eleven = withCards(
      validData(),
      Array.from({ length: 11 }, () => makeCard()),
    );
    expect(collectCarouselIssues(eleven).some((i) => /at most 10 cards/.test(i.message))).toBe(true);
  });

  it('rejects card text over 160 characters', () => {
    const long = makeCard({ text: 'x'.repeat(CAROUSEL_LIMITS.cardTextMaxLength + 1), text_examples: [] });
    const issues = collectCarouselIssues(withCards(validData(), [long, makeCard()]));
    expect(issues.some((i) => /exceeds 160 characters/.test(i.message))).toBe(true);
  });

  it('rejects a 26-character button label', () => {
    const wide = makeCard({
      buttons: [
        { type: 'QUICK_REPLY', text: 'L'.repeat(CAROUSEL_LIMITS.buttonLabelMaxLength + 1), url: null, url_example: null, phone_number: null },
      ],
    });
    const issues = collectCarouselIssues(withCards(validData(), [wide, makeCard()]));
    expect(issues.some((i) => /label exceeds 20 characters|label exceeds \d+ characters/.test(i.message))).toBe(true);
  });

  it('requires at least one button per card (conservative Meta flag #1)', () => {
    const empty = makeCard({ buttons: [] });
    const issues = collectCarouselIssues(
      withCards({ ...validData(), button_layout: [] }, [empty, makeCard()]),
    );
    expect(issues.some((i) => /needs at least one button/.test(i.message))).toBe(true);
  });

  it('rejects a card missing its media', () => {
    const noMedia = makeCard({ media_url: null, media_handle: null });
    const issues = collectCarouselIssues(withCards(validData(), [noMedia, makeCard()]));
    expect(issues.some((i) => /has no image asset/.test(i.message))).toBe(true);
  });

  it('rejects a .mp4 card in an image carousel', () => {
    const wrongType = makeCard({ media_url: 'https://cdn.test/clip.mp4', media_handle: null });
    const issues = collectCarouselIssues(withCards(validData(), [wrongType, makeCard()]));
    expect(issues.some((i) => /is not .* the format the other cards use/.test(i.message))).toBe(true);
  });

  it('enforces card-text samples: count match and non-empty', () => {
    const noSample = makeCard({ text: 'Hi {{1}}', text_examples: [] });
    const issues = collectCarouselIssues(withCards(validData(), [noSample, makeCard()]));
    expect(issues.some((i) => /supply exactly 1 sample value/.test(i.message))).toBe(true);
    const blankSample = makeCard({ text: 'Hi {{1}}', text_examples: ['  '] });
    const issues2 = collectCarouselIssues(withCards(validData(), [blankSample, makeCard()]));
    expect(issues2.some((i) => /empty sample value/.test(i.message))).toBe(true);
  });

  it('requires text on EVERY card when text is enabled (all-or-none rule)', () => {
    const noText = makeCard({ text: '', text_examples: [] });
    const issues = collectCarouselIssues(withCards(validData(), [noText, makeCard()]));
    expect(issues.some((i) => /has no card text/.test(i.message))).toBe(true);
  });

  it('flags a card whose buttons deviate from the shared layout', () => {
    const drifted = makeCard({
      buttons: [
        { type: 'QUICK_REPLY', text: 'A', url: null, url_example: null, phone_number: null },
      ],
    });
    const data = { ...validData(), button_layout: [{ type: 'URL' as const }] };
    const issues = collectCarouselIssues(withCards(data, [drifted, makeCard()]));
    expect(issues.some((i) => /do not match the shared layout/.test(i.message))).toBe(true);
  });

  it('rejects quick replies after a URL button in the layout', () => {
    const data = {
      ...validData(),
      button_layout: [{ type: 'URL' as const }, { type: 'QUICK_REPLY' as const }],
    };
    const issues = collectCarouselIssues(data);
    expect(issues.some((i) => /must come before URL/.test(i.message))).toBe(true);
  });

  it('validates phone-number buttons', () => {
    const bad = makeCard({
      buttons: [{ type: 'PHONE_NUMBER', text: 'Call', url: null, url_example: null, phone_number: 'abc' }],
    });
    const data = { ...validData(), button_layout: [{ type: 'PHONE_NUMBER' as const }] };
    const issues = collectCarouselIssues(withCards(data, [bad, makeCard({ buttons: [{ type: 'PHONE_NUMBER', text: 'Call', url: null, url_example: null, phone_number: 'abc' }] })]));
    expect(issues.some((i) => /digits with a country code/.test(i.message))).toBe(true);
  });

  it('isCarouselCardComplete drives the red dot', () => {
    const data = validData();
    expect(isCarouselCardComplete(data, makeCard(), 0)).toBe(true);
    expect(isCarouselCardComplete(data, makeCard({ media_url: null, media_handle: null }), 0)).toBe(false);
  });
});

describe('carouselUrlIssue — Meta URL rules', () => {
  it('accepts a static URL and one ending with {{1}}', () => {
    expect(carouselUrlIssue('https://example.com/pricing')).toBeNull();
    expect(carouselUrlIssue('https://example.com/u/{{1}}')).toBeNull();
  });

  it('rejects a variable that is not at the very end', () => {
    expect(carouselUrlIssue('https://example.com/{{1}}/x')).toMatch(/at the very end/);
  });

  it('rejects more than one variable, or one that is not {{1}}', () => {
    expect(carouselUrlIssue('https://x.test/{{1}}/{{2}}')).toMatch(/at most one variable/);
    expect(carouselUrlIssue('https://x.test/{{2}}')).toMatch(/must be \{\{1\}\}/);
  });

  it('rejects missing, unparseable, non-http, and over-long URLs', () => {
    expect(carouselUrlIssue('')).toMatch(/required/);
    expect(carouselUrlIssue('not a url')).toMatch(/not valid/);
    expect(carouselUrlIssue('ftp://example.com/x')).toMatch(/http/);
    expect(carouselUrlIssue(`https://x.test/${'y'.repeat(CAROUSEL_LIMITS.urlMaxLength)}`)).toMatch(/exceeds 2000/);
  });
});

describe('validateCarouselSubmission — the server gate', () => {
  const base: TemplatePayload = {
    name: 'spring_sale',
    category: 'Marketing',
    language: 'en_US',
    header_type: 'carousel',
    body_text: 'Hello {{1}}',
    carousel: validData(),
  };

  it('is a no-op for every non-carousel payload', () => {
    expect(() => validateCarouselSubmission({ ...base, header_type: 'text' })).not.toThrow();
    expect(() => validateCarouselSubmission({ ...base, header_type: undefined })).not.toThrow();
  });

  it('requires the Marketing category', () => {
    expect(() =>
      validateCarouselSubmission({ ...base, category: 'Utility' as TemplatePayload['category'] }),
    ).toThrow(/Marketing category/);
  });

  it('forbids footer, top-level buttons, and a top-level header asset', () => {
    expect(() => validateCarouselSubmission({ ...base, footer_text: 'Bye' })).toThrow(/no footer/);
    expect(() =>
      validateCarouselSubmission({
        ...base,
        buttons: [
          { type: 'quick_reply', text: 'x' } as unknown as NonNullable<TemplatePayload['buttons']>[number],
        ],
      }),
    ).toThrow(/no top-level buttons/);
    expect(() => validateCarouselSubmission({ ...base, header_content: 'nope' })).toThrow(/no header asset/);
  });

  it('surfaces the first card problem as a named error', () => {
    const broken = withCards(validData(), [makeCard({ media_url: null, media_handle: null }), makeCard()]);
    expect(() => validateCarouselSubmission({ ...base, carousel: broken })).toThrow(/Card 1 has no image asset/);
  });
});

describe('buildCarouselCreationComponent — POST /<WABA_ID>/message_templates', () => {
  it('emits HEADER(image)+example.header_handle, BUTTONS, and BODY only when text is on', () => {
    const component = buildCarouselCreationComponent(validData()) as unknown as {
      type: string;
      cards: Array<{ components: Array<Record<string, unknown>> }>;
    };
    expect(component.type).toBe('CAROUSEL');
    expect(component.cards).toHaveLength(3);
    const first = component.cards[0].components;
    expect(first[0]).toEqual({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: ['handle-1'] },
    });
    // Body component follows (text enabled), then the buttons component.
    expect(first[1]?.type).toBe('BODY');
    expect((first[1]?.example as { body_text: unknown })?.body_text).toEqual([['there']]);
    expect(first[2]?.type).toBe('BUTTONS');
  });

  it('drops the BODY component when cards carry no text', () => {
    const noText = {
      ...validData(),
      cards_have_text: false,
      cards: [
        makeCard({ text: '', text_examples: [] }),
        makeCard({ text: '', text_examples: [] }),
      ],
    };
    const component = buildCarouselCreationComponent(noText) as unknown as {
      cards: Array<{ components: Array<{ type: string }> }>;
    };
    expect(component.cards[0].components.map((c) => c.type)).toEqual(['HEADER', 'BUTTONS']);
  });

  it('carries URL example and phone_number on the buttons', () => {
    const data = {
      ...validData(),
      button_layout: [{ type: 'URL' as const }],
      cards: [
        makeCard({ buttons: [{ type: 'URL' as const, text: 'Open', url: 'https://x.test/{{1}}', url_example: 'abc', phone_number: null }] }),
      ],
    };
    const component = buildCarouselCreationComponent(data) as unknown as {
      cards: Array<{ components: Array<{ type: string; buttons?: Array<Record<string, unknown>> }> }>;
    };
    const buttons = component.cards[0].components.find((c) => c.type === 'BUTTONS')?.buttons;
    expect(buttons?.[0]).toMatchObject({ type: 'URL', url: 'https://x.test/{{1}}', example: ['abc'] });
  });
});

describe('buildCarouselSendComponent — POST /<PHONE_NUMBER_ID>/messages', () => {
  const media: CarouselSendValues['media'] = [
    { id: 'MEDIA_1' },
    { id: 'MEDIA_2' },
    { id: 'MEDIA_3' },
  ];

  it('throws a card-named error when media is missing', () => {
    expect(() => buildCarouselSendComponent(validData(), 'tpl-1', { cards: [] })).toThrow(
      /Card 1 needs its image uploaded before sending/,
    );
  });

  it('includes ALL cards with zero-based card_index, in template order', () => {
    const values: CarouselSendValues = {
      cards: [{ text: ['A'] }, { text: ['B'] }, { text: ['C'] }],
      media,
    };
    const component = buildCarouselSendComponent(validData(), 'tpl-1', values);
    expect(component.type).toBe('carousel');
    expect(component.cards.map((c) => c.card_index)).toEqual([0, 1, 2]);
    const header = component.cards[1].components[0];
    expect(header).toEqual({ type: 'header', parameters: [{ type: 'image', image: { id: 'MEDIA_2' } }] });
    expect(component.cards[1].components[1]).toEqual({
      type: 'body',
      parameters: [{ type: 'text', text: 'B' }],
    });
  });

  it('uses the deterministic quick-reply payload tpl:<id>:card:<n>:btn:<n>', () => {
    const component = buildCarouselSendComponent(validData(), 'tpl-9', {
      cards: [{ text: ['x'] }, { text: ['y'] }, { text: ['z'] }],
      media: [{ id: 'M1' }, { id: 'M2' }, { id: 'M3' }],
    });
    const button = component.cards[1].components.find((c) => c.type === 'button');
    expect(button).toEqual({
      type: 'button',
      sub_type: 'quick_reply',
      index: '0',
      parameters: [{ type: 'payload', payload: 'tpl:tpl-9:card:1:btn:0' }],
    });
    expect(carouselQuickReplyPayload('t', 2, 1)).toBe('tpl:t:card:2:btn:1');
  });

  it('requires a value for a URL variable and passes it as the url text parameter', () => {
    const data = {
      ...validData(),
      button_layout: [{ type: 'URL' as const }],
      cards: [
        makeCard({ buttons: [{ type: 'URL' as const, text: 'Open', url: 'https://x.test/u/{{1}}', url_example: 's', phone_number: null }] }),
        makeCard({ buttons: [{ type: 'URL' as const, text: 'Open', url: 'https://x.test/u/{{1}}', url_example: 's', phone_number: null }] }),
      ],
    };
    expect(() =>
      buildCarouselSendComponent(data, 'tpl-1', { cards: [{ text: ['a'] }], media: [{ id: 'M' }, { id: 'M' }] }),
    ).toThrow(/URL button 1 uses a variable — a value is required/);

    const component = buildCarouselSendComponent(data, 'tpl-1', {
      cards: [{ text: ['a'], buttonUrls: { 0: 'alice' } }, { text: ['b'], buttonUrls: { 0: 'bob' } }],
      media: [{ id: 'M' }, { id: 'M' }],
    });
    const urlButton = component.cards[0].components.find((c) => c.sub_type === 'url');
    expect(urlButton).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'alice' }],
    });
  });

  it('falls back to a public link when no media id is available', () => {
    const component = buildCarouselSendComponent(
      { ...validData(), cards_have_text: false, cards: [makeCard({ text: '', text_examples: [] })] },
      'tpl-1',
      { cards: [], media: [{ link: 'https://cdn.test/card.jpg' }] },
    );
    expect(component.cards[0].components[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'image', image: { link: 'https://cdn.test/card.jpg' } }],
    });
  });

  it('throws when a card with variables gets too few values', () => {
    expect(() =>
      buildCarouselSendComponent(validData(), 'tpl-1', {
        cards: [{ text: [] }],
        media: [{ id: 'M' }, { id: 'M' }, { id: 'M' }],
      }),
    ).toThrow(/has 1 variable\(s\) but only 0 value/);
  });
});

describe('parseCarousel / parseCarouselSendValues — degrade, never crash', () => {
  it('returns null for junk instead of throwing', () => {
    for (const junk of [undefined, null, 'x', 42, [], {}, { media_format: 'gif', cards: [] }]) {
      expect(parseCarousel(junk)).toBeNull();
    }
  });

  it('round-trips a stored document', () => {
    const data = validData();
    const parsed = parseCarousel(JSON.parse(JSON.stringify(data)));
    expect(parsed?.cards).toHaveLength(3);
    expect(parsed?.media_format).toBe('image');
    expect(parsed?.button_layout).toEqual([{ type: 'QUICK_REPLY' }]);
  });

  it('carouselOf ignores non-carousel rows', () => {
    expect(carouselOf({ header_type: 'text', carousel: validData() })).toBeNull();
    expect(carouselOf({ header_type: 'carousel', carousel: validData() })?.cards).toHaveLength(3);
  });

  it('parseCarouselSendValues filters junk per field', () => {
    expect(parseCarouselSendValues('nope')).toBeNull();
    expect(parseCarouselSendValues({ cards: [] })).toBeNull();
    const v = parseCarouselSendValues({
      cards: [{ text: ['a', 2], buttonUrls: { '0': 'x', '1': '  ', bad: 'y' } }, null],
      media: [{ id: 'M1', link: 5 }, { junk: true }],
    });
    expect(v?.cards[0].text).toEqual(['a', '2']);
    expect(v?.cards[0].buttonUrls).toEqual({ 0: 'x' });
    expect(v?.media).toEqual([{ id: 'M1' }, {}]);
  });
});

describe('carouselFromMetaComponent — sync robustness', () => {
  it('returns null for anything that is not a carousel component', () => {
    expect(carouselFromMetaComponent(null, null)).toBeNull();
    expect(carouselFromMetaComponent({ type: 'BODY' }, null)).toBeNull();
    expect(carouselFromMetaComponent({ type: 'CAROUSEL', cards: [] }, null)).toBeNull();
  });

  it('parses a Meta-shaped carousel and ignores unknown component types', () => {
    const data = carouselFromMetaComponent(
      {
        type: 'CAROUSEL',
        cards: [
          {
            components: [
              { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h1'] } },
              { type: 'MYSTERY_COMPONENT', whatever: true },
              { type: 'BODY', text: 'Deal {{1}}', example: { body_text: [['X']] } },
              { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Buy' }] },
            ],
          },
          {
            components: [
              { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h2'] } },
              { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open', url: 'https://x.test/{{1}}', example: ['s'] }] },
            ],
          },
        ],
      },
      null,
    );
    expect(data?.media_format).toBe('image');
    expect(data?.cards).toHaveLength(2);
    expect(data?.cards[0].media_handle).toBe('h1');
    expect(data?.cards[0].text).toBe('Deal {{1}}');
    expect(data?.cards[0].text_examples).toEqual(['X']);
    expect(data?.cards[1].buttons[0]).toMatchObject({ type: 'URL', url_example: 's' });
  });

  it('marks video carousels and keeps previously synced media urls', () => {
    const existing = validData();
    const data = carouselFromMetaComponent(
      {
        type: 'CAROUSEL',
        cards: [
          { components: [{ type: 'HEADER', format: 'VIDEO', example: { header_handle: ['v'] } }] },
        ],
      },
      existing,
    );
    expect(data?.media_format).toBe('video');
    expect(data?.cards[0].media_url).toBe('https://cdn.test/card.jpg');
  });
});

describe('carouselScopes — broadcast per-recipient mapping keys', () => {
  it('lists card text + variable URL scopes, never body keys', () => {
    const data = {
      ...validData(),
      button_layout: [{ type: 'URL' as const }],
      cards: [
        makeCard({
          text: 'Hi {{1}}, order {{2}}',
          text_examples: ['a', 'b'],
          buttons: [{ type: 'URL' as const, text: 'Open', url: 'https://x.test/{{1}}', url_example: 's', phone_number: null }],
        }),
        makeCard({
          buttons: [{ type: 'URL' as const, text: 'Static', url: 'https://x.test/fixed', url_example: null, phone_number: null }],
        }),
      ],
    };
    const scopes = carouselScopes(data);
    expect(scopes.map((s) => s.key)).toEqual([
      'card.0.text.1',
      'card.0.text.2',
      'card.0.button.0.url',
      'card.1.text.1',
    ]);
    expect(scopes[0].label).toBe('Card 1 text 1');
    expect(scopes[2].label).toBe('Card 1 URL button');
    expect(scopes[2].sample).toBe('s');
  });
});

describe('buildCarouselSnapshotCards — what the thread records', () => {
  it('substitutes this recipient\'s values and keeps unfilled tokens visible', () => {
    const cards = buildCarouselSnapshotCards(validData(), {
      cards: [{ text: ['Anna'] }],
      media: [{ id: 'M1' }],
    });
    expect(cards).toHaveLength(3);
    expect(cards[0].text).toBe('Hi Anna');
    // Recipient 2/3 had no values — the token stays rather than going blank.
    expect(cards[1].text).toBe('Hi {{1}}');
    expect(cards[0].mediaUrl).toBe('https://cdn.test/card.jpg');
    expect(cards[0].kind).toBe('image');
    expect(cards[0].buttons[0]).toMatchObject({ type: 'QUICK_REPLY', text: 'Buy' });
  });
});
