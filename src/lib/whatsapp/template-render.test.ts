import { describe, expect, it } from 'vitest';

import type { Message, MessageTemplate } from '@/types';

import {
  buildSendTemplateSnapshot,
  buildTemplatePayload,
  isMissingColumnError,
  parseTemplatePayload,
  payloadFromTemplateRow,
  resolveTemplateRender,
  splitWhatsAppMarkup,
  type TemplateIndex,
} from './template-render';

// ============================================================
// The snapshot the Inbox bubble renders from (migration 053). Pure
// module, so the whole contract is testable without React: what a send
// site records and what a bubble reads must be the same function.
// ============================================================

function template(
  overrides: Partial<MessageTemplate> = {}
): MessageTemplate {
  return {
    id: 'tpl-1',
    user_id: 'u-1',
    name: 'order_update',
    category: 'Utility',
    language: 'en_US',
    body_text: 'Your order {{1}} ships on {{2}}.',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    conversation_id: 'cv-1',
    sender_type: 'agent',
    content_type: 'template',
    content_text: 'Your order A123 ships on Friday.',
    template_name: 'order_update',
    status: 'sent',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildTemplatePayload — body', () => {
  it('prefers the body the caller already rendered', () => {
    const payload = buildTemplatePayload({
      template: template(),
      name: 'order_update',
      bodyParams: ['A123', 'Friday'],
      renderedBody: 'rendered by the composer',
    });
    expect(payload?.body).toBe('rendered by the composer');
  });

  it('substitutes the params itself when the caller sent no text', () => {
    const payload = buildTemplatePayload({
      template: template(),
      name: 'order_update',
      bodyParams: ['A123', 'Friday'],
    });
    expect(payload?.body).toBe('Your order A123 ships on Friday.');
  });

  it('leaves an unfilled token visible instead of blanking it', () => {
    const payload = buildTemplatePayload({
      template: template(),
      name: 'order_update',
      bodyParams: ['A123'],
    });
    expect(payload?.body).toBe('Your order A123 ships on {{2}}.');
  });

  it('records nothing when there is neither a row nor a rendered body', () => {
    expect(buildTemplatePayload({ template: null, name: 'ghost' })).toBeNull();
    // …and the body alone is still worth a snapshot.
    expect(
      buildTemplatePayload({ template: null, name: 'ghost', renderedBody: 'Hi' })
    ).toMatchObject({ body: 'Hi', buttons: [], header: null });
  });

  it('falls back to en_US so the reader never sees an undefined language', () => {
    expect(
      buildTemplatePayload({ template: { ...template(), language: undefined }, name: 'x', renderedBody: 'y' })
        ?.language
    ).toBe('en_US');
    expect(buildTemplatePayload({ template: null, name: 'x', renderedBody: 'y' })?.language).toBe(
      'en_US'
    );
  });
});

describe('buildTemplatePayload — header', () => {
  it('renders a static text header as-is', () => {
    const payload = buildTemplatePayload({
      template: template({ header_type: 'text', header_content: 'Order update' }),
      name: 'order_update',
    });
    expect(payload?.header).toEqual({
      kind: 'text',
      text: 'Order update',
      mediaUrl: null,
      mediaId: null,
      filename: null,
    });
  });

  it('fills a text header variable from the send-time value', () => {
    const payload = buildTemplatePayload({
      template: template({ header_type: 'text', header_content: 'Hi {{1}}' }),
      name: 'order_update',
      headerText: 'Ashu',
    });
    expect(payload?.header?.text).toBe('Hi Ashu');
  });

  it('uses the send-time media override for a media header', () => {
    const payload = buildTemplatePayload({
      template: template({
        header_type: 'image',
        header_handle: 'creation-time-sample-handle',
        header_media_url: 'https://cdn/stored.jpg',
      }),
      name: 'order_update',
      headerMediaUrl: 'https://cdn/per-recipient.jpg',
    });
    // `header_handle` is a TEMPLATE-CREATION sample, never a send-time id
    // (see template-send-builder.ts) — it must not leak into the render.
    expect(payload?.header).toEqual({
      kind: 'image',
      text: null,
      mediaUrl: 'https://cdn/per-recipient.jpg',
      mediaId: null,
      filename: null,
    });
  });

  it('records a send-time media id without inventing a link', () => {
    const payload = buildTemplatePayload({
      template: template({
        header_type: 'document',
        header_handle: 'creation-time-sample-handle',
      }),
      name: 'order_update',
      headerMediaId: '9977',
    });
    // An id is not a URL: it is recorded as what it is, and the bubble
    // falls back to its placeholder instead of a broken <img>.
    expect(payload?.header).toEqual({
      kind: 'document',
      text: null,
      mediaUrl: null,
      mediaId: '9977',
      filename: null,
    });
  });

  it('keeps a media header that has no reachable URL', () => {
    const payload = buildTemplatePayload({
      template: template({ header_type: 'video' }),
      name: 'order_update',
    });
    // The header existed and the recipient saw it, so the bubble shows a
    // labelled placeholder rather than dropping it silently.
    expect(payload?.header).toEqual({
      kind: 'video',
      text: null,
      mediaUrl: null,
      mediaId: null,
      filename: null,
    });
  });

  it('takes a document filename from header_content', () => {
    const payload = buildTemplatePayload({
      template: template({
        header_type: 'document',
        header_content: 'invoice.pdf',
        header_media_url: 'https://cdn/invoice.pdf',
      }),
      name: 'order_update',
    });
    expect(payload?.header).toEqual({
      kind: 'document',
      text: null,
      mediaUrl: 'https://cdn/invoice.pdf',
      mediaId: null,
      filename: 'invoice.pdf',
    });
  });

  it('ignores an unknown header kind', () => {
    const payload = buildTemplatePayload({
      template: template({ header_type: 'audio' as MessageTemplate['header_type'] }),
      name: 'order_update',
    });
    expect(payload?.header).toBeNull();
  });
});

describe('buildTemplatePayload — buttons', () => {
  it('substitutes a URL button variable and keeps the label', () => {
    const payload = buildTemplatePayload({
      template: template({
        buttons: [{ type: 'URL', text: 'Track', url: 'https://x/track?o={{1}}' }],
      }),
      name: 'order_update',
      buttonParams: { 0: 'A123' },
    });
    expect(payload?.buttons).toEqual([
      {
        type: 'URL',
        text: 'Track',
        url: 'https://x/track?o=A123',
        phoneNumber: null,
        code: null,
      },
    ]);
  });

  it('carries the phone number and the copy-code value', () => {
    const payload = buildTemplatePayload({
      template: template({
        buttons: [
          { type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+15551234567' },
          { type: 'COPY_CODE', text: 'Copy code', example: 'SAVE10' },
        ],
      }),
      name: 'order_update',
      buttonParams: { 1: 'SAVE20' },
    });
    expect(payload?.buttons[0]).toMatchObject({
      type: 'PHONE_NUMBER',
      phoneNumber: '+15551234567',
    });
    // The send-time override is what the recipient's button copies.
    expect(payload?.buttons[1]).toMatchObject({ type: 'COPY_CODE', code: 'SAVE20' });
  });

  it('records QUICK_REPLY and FLOW as label-only rows', () => {
    const payload = buildTemplatePayload({
      template: template({
        buttons: [
          { type: 'QUICK_REPLY', text: 'Yes' },
          { type: 'FLOW', text: 'Book', flow_id: '100' },
        ],
      }),
      name: 'order_update',
    });
    expect(payload?.buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Yes', url: null, phoneNumber: null, code: null },
      { type: 'FLOW', text: 'Book', url: null, phoneNumber: null, code: null },
    ]);
  });

  it('tolerates a row with no buttons array', () => {
    expect(buildTemplatePayload({ template: template(), name: 'x' })?.buttons).toEqual([]);
  });
});

// ============================================================
// Send-site entry point
// ============================================================

describe('buildSendTemplateSnapshot', () => {
  it('reads the structured send-time params shape', () => {
    const snapshot = buildSendTemplateSnapshot({
      template: template({
        header_type: 'text',
        header_content: 'Hi {{1}}',
        buttons: [{ type: 'URL', text: 'Track', url: 'https://x/o={{1}}' }],
        footer_text: 'ACME',
      }),
      name: 'order_update',
      language: 'en',
      messageParams: {
        body: ['A123', 'Friday'],
        headerText: 'Ashu',
        buttonParams: { 0: 'A123' },
      },
      storedBody: 'Your order A123 ships on Friday.',
    });
    expect(snapshot).toMatchObject({
      name: 'order_update',
      language: 'en',
      category: 'Utility',
      header: { kind: 'text', text: 'Hi Ashu' },
      body: 'Your order A123 ships on Friday.',
      footer: 'ACME',
    });
    expect(snapshot?.buttons[0].url).toBe('https://x/o=A123');
  });

  it('prefers structured body values over the legacy array', () => {
    const snapshot = buildSendTemplateSnapshot({
      template: template(),
      name: 'order_update',
      messageParams: { body: ['STRUCT', 'VALUES'] },
      bodyParams: ['LEGACY', 'ARRAY'],
    });
    expect(snapshot?.body).toBe('Your order STRUCT ships on VALUES.');
  });

  it('falls back to the legacy array when the shape carries no body', () => {
    const snapshot = buildSendTemplateSnapshot({
      template: template(),
      name: 'order_update',
      messageParams: { headerText: 'only a header' },
      bodyParams: ['A123', 'Friday'],
    });
    expect(snapshot?.body).toBe('Your order A123 ships on Friday.');
  });

  it('forwards a send-time media id out of the structured params', () => {
    const snapshot = buildSendTemplateSnapshot({
      template: template({ header_type: 'image' }),
      name: 'order_update',
      messageParams: { headerMediaId: '9977' },
    });
    expect(snapshot?.header?.mediaId).toBe('9977');
    expect(snapshot?.header?.mediaUrl).toBeNull();
  });

  it('survives junk in messageParams — a bad caller still gets a snapshot', () => {
    for (const junk of [undefined, null, 'string', 42, [], { body: 'not-an-array' }]) {
      const snapshot = buildSendTemplateSnapshot({
        template: template(),
        name: 'order_update',
        messageParams: junk,
        bodyParams: ['A123', 'Friday'],
      });
      expect(snapshot?.body).toBe('Your order A123 ships on Friday.');
    }
  });

  it('drops non-numeric and empty button-param keys', () => {
    const snapshot = buildSendTemplateSnapshot({
      template: template({
        buttons: [
          { type: 'URL', text: 'One', url: 'https://x/a={{1}}' },
          { type: 'COPY_CODE', text: 'Two', example: 'STATIC' },
        ],
      }),
      name: 'order_update',
      messageParams: { buttonParams: { '0': 'A', '1': '  ', '-1': 'neg', 'x': 'bad' } },
    });
    // Index 0 substituted; index 1's blank override must NOT blank the
    // approved example, and the bogus keys are ignored outright.
    expect(snapshot?.buttons[0].url).toBe('https://x/a=A');
    expect(snapshot?.buttons[1].code).toBe('STATIC');
  });

  it('returns null when nothing is known about the delivery', () => {
    expect(buildSendTemplateSnapshot({ template: null, name: 'ghost' })).toBeNull();
  });

  it('records nothing when the send resolved no local row — not even the body', () => {
    // A body-only snapshot would duplicate content_text AND permanently
    // outrank the thread's reconstruction, so a template synced after
    // this send could never show its header / footer / buttons.
    expect(
      buildSendTemplateSnapshot({
        template: null,
        name: 'ghost',
        storedBody: 'Your order A123 ships on Friday.',
      })
    ).toBeNull();
    expect(
      buildSendTemplateSnapshot({ template: undefined, name: 'ghost', bodyParams: ['A123'] })
    ).toBeNull();
  });
});

// ============================================================
// Reading it back
// ============================================================

describe('parseTemplatePayload', () => {
  it('round-trips a snapshot through JSON unchanged', () => {
    const built = buildTemplatePayload({
      template: template({
        header_type: 'image',
        header_media_url: 'https://cdn/a.jpg',
        footer_text: 'ACME',
        buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }],
      }),
      name: 'order_update',
      bodyParams: ['A123', 'Friday'],
    })!;
    expect(parseTemplatePayload(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it('rejects anything that is not a payload instead of throwing', () => {
    for (const junk of [undefined, null, 0, 'body', [], { name: 'only-name' }]) {
      expect(parseTemplatePayload(junk)).toBeNull();
    }
  });

  it('drops malformed buttons and keeps the well-formed ones', () => {
    const parsed = parseTemplatePayload({
      name: 'n',
      body: 'b',
      buttons: [
        { type: 'URL', text: 'Ok', url: 'https://x' },
        { type: 'MYSTERY', text: 'Nope' },
        'not-an-object',
        null,
      ],
    });
    expect(parsed?.buttons).toHaveLength(1);
    expect(parsed?.buttons[0]).toMatchObject({ type: 'URL', text: 'Ok' });
  });

  it('drops an unknown header kind but still returns the body', () => {
    const parsed = parseTemplatePayload({
      name: 'n',
      body: 'b',
      header: { kind: 'audio', mediaUrl: 'https://x' },
    });
    expect(parsed?.header).toBeNull();
    expect(parsed?.body).toBe('b');
  });

  it('normalises missing optional fields to null', () => {
    expect(parseTemplatePayload({ name: 'n', body: 'b' })).toEqual({
      name: 'n',
      language: 'en_US',
      category: null,
      header: null,
      body: 'b',
      footer: null,
      buttons: [],
    });
  });
});

describe('payloadFromTemplateRow (legacy reconstruction)', () => {
  it('shows the text that was actually stored, not the raw template', () => {
    const payload = payloadFromTemplateRow(template(), {
      name: 'order_update',
      storedBody: 'Your order A123 ships on Friday.',
    });
    expect(payload.body).toBe('Your order A123 ships on Friday.');
  });

  it('falls back to the template body when the row stored nothing', () => {
    const payload = payloadFromTemplateRow(template(), { name: 'order_update' });
    // Tokens stay visible — the send happened with values we never kept.
    expect(payload.body).toBe('Your order {{1}} ships on {{2}}.');
  });
});

describe('resolveTemplateRender', () => {
  const index = (rows: MessageTemplate[]): TemplateIndex => {
    const map: TemplateIndex = new Map();
    for (const row of rows) map.set(row.name, row);
    return map;
  };

  it('prefers the stored snapshot over the live template', () => {
    const stored = {
      name: 'order_update',
      language: 'en_US',
      category: null,
      header: null,
      body: 'Delivered body',
      footer: null,
      buttons: [],
    };
    const resolved = resolveTemplateRender(
      message({ template_payload: stored }),
      index([template({ body_text: 'EDITED AFTER THE SEND' })])
    );
    expect(resolved?.body).toBe('Delivered body');
  });

  it('reconstructs a legacy row from the template index', () => {
    const resolved = resolveTemplateRender(
      message(),
      index([template({ header_type: 'text', header_content: 'Order update', footer_text: 'ACME' })])
    );
    expect(resolved?.header?.text).toBe('Order update');
    expect(resolved?.footer).toBe('ACME');
    expect(resolved?.body).toBe('Your order A123 ships on Friday.');
  });

  it('matches a template name whatever case it was stored in', () => {
    const resolved = resolveTemplateRender(
      message({ template_name: 'Order_Update' }),
      index([template({ name: 'Order_Update' })])
    );
    expect(resolved).not.toBeNull();
  });

  it('returns null with no snapshot and no index entry', () => {
    expect(resolveTemplateRender(message(), new Map())).toBeNull();
    expect(resolveTemplateRender(message())).toBeNull();
    expect(resolveTemplateRender(message({ template_name: undefined }))).toBeNull();
  });

  it('treats a corrupt snapshot as no snapshot, then reconstructs', () => {
    const resolved = resolveTemplateRender(
      { ...message(), template_payload: { nonsense: true } as never },
      index([template()])
    );
    expect(resolved?.body).toBe('Your order A123 ships on Friday.');
  });
});

// ============================================================
// WhatsApp markup
// ============================================================

describe('splitWhatsAppMarkup', () => {
  const styles = (text: string) => splitWhatsAppMarkup(text);

  it('pairs each delimiter with its style', () => {
    expect(styles('*bold* _italic_ ~strike~ `mono`')).toEqual([
      { text: 'bold', style: 'bold' },
      { text: ' ', style: 'normal' },
      { text: 'italic', style: 'italic' },
      { text: ' ', style: 'normal' },
      { text: 'strike', style: 'strike' },
      { text: ' ', style: 'normal' },
      { text: 'mono', style: 'mono' },
    ]);
  });

  it('leaves an unpaired delimiter literal — the bug behind "*Contact : 9640…"', () => {
    expect(styles('*Contact : 9640111265')).toEqual([
      { text: '*Contact : 9640111265', style: 'normal' },
    ]);
  });

  it('never lets a run cross a newline', () => {
    expect(styles('*two\nlines*')).toEqual([{ text: '*two\nlines*', style: 'normal' }]);
  });

  it('keeps plain text and empty input intact', () => {
    expect(styles('Hello')).toEqual([{ text: 'Hello', style: 'normal' }]);
    expect(styles('')).toEqual([]);
  });

  it('does not bold an empty run', () => {
    expect(styles('a ** b')).toEqual([{ text: 'a ** b', style: 'normal' }]);
  });
});

// ============================================================
// Deployment safety
// ============================================================

describe('isMissingColumnError', () => {
  it('recognises the undefined-column SQLSTATE', () => {
    expect(isMissingColumnError({ code: '42703', message: 'x' }, 'template_payload')).toBe(true);
    expect(
      isMissingColumnError({ code: 'PGRST204', message: 'x' }, 'template_payload')
    ).toBe(true);
  });

  it('recognises PostgREST schema-cache phrasing', () => {
    expect(
      isMissingColumnError(
        { message: "column 'messages.template_payload' does not exist" },
        'template_payload'
      )
    ).toBe(true);
    expect(
      isMissingColumnError({ message: 'template_payload not found' }, 'template_payload')
    ).toBe(true);
  });

  it('never claims a missing column for an unrelated failure', () => {
    // A unique violation, an RLS rejection or a different column must all
    // keep failing loudly — retrying without the snapshot would hide them.
    expect(
      isMissingColumnError({ code: '23505', message: 'duplicate key value' }, 'template_payload')
    ).toBe(false);
    expect(
      isMissingColumnError({ message: 'row-level security policy' }, 'template_payload')
    ).toBe(false);
    expect(
      isMissingColumnError({ message: 'column messages.error_title does not exist' }, 'template_payload')
    ).toBe(false);
    expect(isMissingColumnError(null, 'template_payload')).toBe(false);
    expect(isMissingColumnError('42703', 'template_payload')).toBe(false);
  });
});
