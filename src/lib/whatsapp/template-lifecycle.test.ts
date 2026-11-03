import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteMessageTemplate,
  editMessageTemplate,
  isTemplateGoneOnMeta,
  submitMessageTemplate,
} from './meta-api';

// We mock fetch and assert on the request URL/method/body — these
// helpers have no validation of their own (they trust the validators
// upstream), so the contract we care about is the exact wire shape.

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('submitMessageTemplate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      okResponse({ id: '123', status: 'PENDING', category: 'UTILITY' }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /{wabaId}/message_templates with the payload as JSON', async () => {
    const result = await submitMessageTemplate({
      wabaId: 'WABA1',
      accessToken: 'tok',
      payload: {
        name: 't',
        category: 'UTILITY',
        language: 'en_US',
        components: [{ type: 'BODY', text: 'hi' }],
      },
    });
    expect(result).toEqual({ id: '123', status: 'PENDING', category: 'UTILITY' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/WABA1/message_templates');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({
      name: 't',
      category: 'UTILITY',
      language: 'en_US',
      components: [{ type: 'BODY', text: 'hi' }],
    });
  });

  it('throws Meta\'s error message on non-OK responses', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(429, {
        error: { message: 'Rate limit (#80007).' },
      }),
    );
    await expect(
      submitMessageTemplate({
        wabaId: 'W',
        accessToken: 't',
        payload: {
          name: 'n',
          category: 'UTILITY',
          language: 'en_US',
          components: [],
        },
      }),
    ).rejects.toThrow(/Rate limit/);
  });

  it('throws if Meta accepts but returns no id (data integrity guard)', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ status: 'PENDING' }));
    await expect(
      submitMessageTemplate({
        wabaId: 'W',
        accessToken: 't',
        payload: {
          name: 'n',
          category: 'UTILITY',
          language: 'en_US',
          components: [],
        },
      }),
    ).rejects.toThrow(/no id/);
  });
});

describe('editMessageTemplate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /{templateId} with only `components` in the body by default', async () => {
    await editMessageTemplate({
      metaTemplateId: 'TMPL_42',
      accessToken: 'tok',
      components: [{ type: 'BODY', text: 'new body' }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/TMPL_42');
    expect(url).not.toContain('message_templates');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      components: [{ type: 'BODY', text: 'new body' }],
    });
  });

  it('includes `category` when provided', async () => {
    await editMessageTemplate({
      metaTemplateId: 'TMPL_42',
      accessToken: 'tok',
      components: [{ type: 'BODY', text: 'x' }],
      category: 'MARKETING',
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      components: [{ type: 'BODY', text: 'x' }],
      category: 'MARKETING',
    });
  });

  it('returns success:true on Meta success', async () => {
    expect(
      await editMessageTemplate({
        metaTemplateId: 'T',
        accessToken: 't',
        components: [],
      }),
    ).toEqual({ success: true });
  });

  it('treats { success: false } as failure', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ success: false }));
    expect(
      await editMessageTemplate({
        metaTemplateId: 'T',
        accessToken: 't',
        components: [],
      }),
    ).toEqual({ success: false });
  });
});

describe('deleteMessageTemplate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('DELETEs with name only when no metaTemplateId is given', async () => {
    await deleteMessageTemplate({
      wabaId: 'W',
      accessToken: 't',
      name: 'order_confirmation',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/W/message_templates');
    expect(url).toContain('name=order_confirmation');
    expect(url).not.toContain('hsm_id');
    expect(init.method).toBe('DELETE');
  });

  it('scopes to one language variant by including hsm_id', async () => {
    // This is THE bug the plan flagged: without hsm_id, Meta deletes
    // every language variant of `name`. Verifying it's always sent.
    await deleteMessageTemplate({
      wabaId: 'W',
      accessToken: 't',
      name: 'order_confirmation',
      metaTemplateId: '12345',
    });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('name=order_confirmation');
    expect(url).toContain('hsm_id=12345');
  });

  it('treats 404 as a no-op (template already gone on Meta)', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(404, { error: { message: 'not found' } }),
    );
    await expect(
      deleteMessageTemplate({
        wabaId: 'W',
        accessToken: 't',
        name: 'x',
        metaTemplateId: 'y',
      }),
    ).resolves.toBeUndefined();
  });

  it('throws on non-404 errors', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(500, { error: { message: 'boom' } }),
    );
    await expect(
      deleteMessageTemplate({
        wabaId: 'W',
        accessToken: 't',
        name: 'x',
        metaTemplateId: 'y',
      }),
    ).rejects.toThrow(/boom/);
  });

  // Meta answers a template it has already dropped with HTTP 400
  // "(#100) Invalid parameter" — the same envelope a malformed request
  // gets. The delete helper does not guess which it hit; it hands the
  // refusal to the caller, which asks `isTemplateGoneOnMeta`.
  it('throws the Meta message for a 400 refusal, without probing', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(400, { error: { message: 'Invalid parameter', code: 100 } }),
    );

    await expect(
      deleteMessageTemplate({
        wabaId: 'W',
        accessToken: 't',
        name: 'ashwini',
        metaTemplateId: '996778509811309',
      }),
    ).rejects.toThrow(/Invalid parameter/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('isTemplateGoneOnMeta', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The WABA list endpoint ignores hsm_id and prefix-matches on name, so
  // a dead `ashwini` id looks "present" there. Only the by-id read is a
  // verdict about this template.
  it('reads the object by id, not through the WABA list', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(400, {
        error: {
          code: 100,
          error_subcode: 33,
          message: "Unsupported get request. Object with ID '996778509811309' does not exist",
        },
      }),
    );

    await expect(
      isTemplateGoneOnMeta({ metaTemplateId: '996778509811309', accessToken: 't' }),
    ).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/996778509811309?fields=id');
    expect(url).not.toContain('message_templates');
    expect(init.headers.Authorization).toBe('Bearer t');
  });

  it('reports a live template as present', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: '996778509811309' }));
    await expect(
      isTemplateGoneOnMeta({ metaTemplateId: '996778509811309', accessToken: 't' }),
    ).resolves.toBe(false);
  });

  it('treats 404 as gone', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(404, { error: { message: 'nope' } }));
    await expect(
      isTemplateGoneOnMeta({ metaTemplateId: '1', accessToken: 't' }),
    ).resolves.toBe(true);
  });

  it('keeps a token failure as present so the refusal stays visible', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(401, { error: { code: 190, message: 'Error validating access token' } }),
    );
    await expect(
      isTemplateGoneOnMeta({ metaTemplateId: '1', accessToken: 't' }),
    ).resolves.toBe(false);
  });

  it('does not read a bare #100 without subcode 33 as gone', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(400, { error: { code: 100, message: 'Invalid parameter' } }),
    );
    await expect(
      isTemplateGoneOnMeta({ metaTemplateId: '1', accessToken: 't' }),
    ).resolves.toBe(false);
  });

  it('short-circuits a synthetic dry-run id without calling Meta', async () => {
    await expect(
      isTemplateGoneOnMeta({ metaTemplateId: 'dry-run-9f2d', accessToken: 't' }),
    ).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports present when the probe itself throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(
      isTemplateGoneOnMeta({ metaTemplateId: '1', accessToken: 't' }),
    ).resolves.toBe(false);
  });
});
