import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TEMPLATE_SAMPLE_FOLDER,
  isMediaHeaderType,
  isMetaCdnSampleUrl,
  isMirroredMediaUrl,
  isMirrorableSampleUrl,
  mirrorTemplateSampleMedia,
  needsMediaMirror,
  templateSampleObjectPath,
} from "./template-sample-media";
import { MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";
/** The shape Meta actually returns: a signed, short-lived CDN link. */
const SAMPLE_URL =
  "https://scontent.whatsapp.net/v/t61.29466-34/719216211_n.png?oh=abc&oe=6AF01C60";

/** Mirrors the real Supabase Storage public-URL shape, not a toy one. */
function publicUrlFor(path: string): string {
  return `https://proj.supabase.co/storage/v1/object/public/chat-media/${path}`;
}

function fakeStorage(uploadError: { message: string } | null = null) {
  const uploads: Array<{
    bucket: string;
    path: string;
    body: Uint8Array | Buffer;
    options: { contentType: string; cacheControl: string; upsert: boolean };
  }> = [];

  const storage = {
    from(bucket: string) {
      return {
        async upload(
          path: string,
          body: Uint8Array | Buffer,
          options: {
            contentType: string;
            cacheControl: string;
            upsert: boolean;
          },
        ) {
          uploads.push({ bucket, path, body, options });
          return { error: uploadError };
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: publicUrlFor(path) } };
        },
      };
    },
  };

  return { storage, uploads };
}

function fakeDownload(bytes: number, contentType = "image/png") {
  return vi.fn(async () => ({ buffer: Buffer.alloc(bytes), contentType }));
}

const BASE = {
  accountId: ACCOUNT,
  templateName: "ashwini_ad1",
  language: "en",
  sampleUrl: SAMPLE_URL,
  accessToken: "test-token",
} as const;

describe("isMediaHeaderType", () => {
  it("accepts the three formats that carry media, any case", () => {
    expect(isMediaHeaderType("image")).toBe(true);
    // Meta's `format` arrives upper-cased.
    expect(isMediaHeaderType("VIDEO")).toBe(true);
    expect(isMediaHeaderType("Document")).toBe(true);
  });

  it("rejects text and absent headers", () => {
    expect(isMediaHeaderType("text")).toBe(false);
    expect(isMediaHeaderType(null)).toBe(false);
    expect(isMediaHeaderType(undefined)).toBe(false);
    expect(isMediaHeaderType("")).toBe(false);
  });
});

describe("isMirrorableSampleUrl", () => {
  it("accepts http and https", () => {
    expect(isMirrorableSampleUrl(SAMPLE_URL)).toBe(true);
    expect(isMirrorableSampleUrl("http://cdn.test/a.png")).toBe(true);
  });

  it("rejects the opaque creation handle and empty values", () => {
    // `example.header_handle` is named like the creation-time handle and
    // could plausibly carry one; it is not fetchable.
    expect(isMirrorableSampleUrl("4::aW1hZ2U=")).toBe(false);
    expect(isMirrorableSampleUrl("//cdn.test/a.png")).toBe(false);
    expect(isMirrorableSampleUrl("ftp://cdn.test/a.png")).toBe(false);
    expect(isMirrorableSampleUrl(null)).toBe(false);
    expect(isMirrorableSampleUrl(undefined)).toBe(false);
  });
});

describe("isMirroredMediaUrl", () => {
  it("recognises our own public bucket URL", () => {
    expect(isMirroredMediaUrl(publicUrlFor("account-x/y/template.png"))).toBe(
      true,
    );
  });

  it("does not treat Meta's CDN sample as our copy", () => {
    // This is the whole bug: the stored value used to be this URL.
    expect(isMirroredMediaUrl(SAMPLE_URL)).toBe(false);
    expect(isMirroredMediaUrl(null)).toBe(false);
    expect(isMirroredMediaUrl("/api/whatsapp/media/123")).toBe(false);
  });
});

describe("isMetaCdnSampleUrl", () => {
  it("recognises the hosts that serve template samples", () => {
    expect(isMetaCdnSampleUrl(SAMPLE_URL)).toBe(true);
    // Meta's other CDN host (the one inbound media downloads come from)
    // signs its links the same way, so it counts as expiring too.
    expect(isMetaCdnSampleUrl("https://lookaside.fbsbx.com/w/a.png")).toBe(
      true,
    );
    expect(isMetaCdnSampleUrl("https://fbcdn.net/a.jpg")).toBe(true);
  });

  it("is not fooled by a substring in the path or a lookalike domain", () => {
    // `endsWith` is against the hostname, never the whole URL.
    expect(isMetaCdnSampleUrl("https://evil.test/?u=scontent.whatsapp.net")).toBe(
      false,
    );
    expect(isMetaCdnSampleUrl("https://whatsapp.net.evil.test/a.png")).toBe(
      false,
    );
  });

  it("rejects our bucket, relative paths and non-URLs", () => {
    expect(isMetaCdnSampleUrl(publicUrlFor("account-x/template-headers/a.png"))).toBe(
      false,
    );
    expect(isMetaCdnSampleUrl("/api/whatsapp/media/123")).toBe(false);
    expect(isMetaCdnSampleUrl("4::aW1hZ2U=")).toBe(false);
    expect(isMetaCdnSampleUrl(null)).toBe(false);
    expect(isMetaCdnSampleUrl(undefined)).toBe(false);
  });
});

describe("needsMediaMirror", () => {
  it("repairs the legacy state: empty, or an expiring Meta link", () => {
    // Every template that has only ever arrived through "Sync from Meta".
    expect(needsMediaMirror(null)).toBe(true);
    expect(needsMediaMirror(undefined)).toBe(true);
    expect(needsMediaMirror("")).toBe(true);
    // A link saved by a previous sync — 403 by now.
    expect(needsMediaMirror(SAMPLE_URL)).toBe(true);
  });

  it("leaves durable URLs alone, so a steady-state sync fetches nothing", () => {
    expect(needsMediaMirror(publicUrlFor("account-x/template-headers/a.png"))).toBe(
      false,
    );
    // An operator's own CDN link is deliberate, not broken.
    expect(needsMediaMirror("https://assets.business.test/head.png")).toBe(
      false,
    );
  });
});

describe("templateSampleObjectPath", () => {
  it("is account-scoped, folder-nested, and carries name + language", () => {
    expect(
      templateSampleObjectPath({
        accountId: ACCOUNT,
        templateName: "ashwini_ad1",
        language: "en",
        mimeType: "image/png",
      }),
    ).toBe(
      `account-${ACCOUNT}/${TEMPLATE_SAMPLE_FOLDER}/ashwini_ad1-en.png`,
    );
  });

  it("is stable across calls so re-syncing overwrites instead of littering", () => {
    const args = {
      accountId: ACCOUNT,
      templateName: "promo",
      language: "en_US",
      mimeType: "image/jpeg",
    } as const;
    expect(templateSampleObjectPath(args)).toBe(templateSampleObjectPath(args));
  });

  it("keeps language variants apart", () => {
    const base = { accountId: ACCOUNT, templateName: "promo" } as const;
    const en = templateSampleObjectPath({
      ...base,
      language: "en",
      mimeType: "image/png",
    });
    const es = templateSampleObjectPath({
      ...base,
      language: "es",
      mimeType: "image/png",
    });
    expect(en).not.toBe(es);
  });

  it("falls back to .bin for an unknown MIME and sanitises the name", () => {
    const path = templateSampleObjectPath({
      accountId: ACCOUNT,
      templateName: "Two Words!",
      language: "en",
      mimeType: null,
    });
    // Each run of unsafe characters becomes one `_`, and `.bin` stands in
    // for a MIME the extension table doesn't know.
    expect(path).toBe(
      `account-${ACCOUNT}/${TEMPLATE_SAMPLE_FOLDER}/Two_Words_-en.bin`,
    );
  });
});

describe("mirrorTemplateSampleMedia", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Best-effort failures log; keep the run quiet and assert on them.
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("uploads to the public chat-media bucket and returns its URL", async () => {
    const { storage, uploads } = fakeStorage();
    const url = await mirrorTemplateSampleMedia({
      ...BASE,
      storage,
      download: fakeDownload(2048),
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0].bucket).toBe("chat-media");
    expect(uploads[0].path).toBe(
      `account-${ACCOUNT}/${TEMPLATE_SAMPLE_FOLDER}/ashwini_ad1-en.png`,
    );
    expect(url).toBe(publicUrlFor(uploads[0].path));
  });

  it("upserts, because the object path is deliberately stable", async () => {
    const { storage, uploads } = fakeStorage();
    await mirrorTemplateSampleMedia({ ...BASE, storage, download: fakeDownload(10) });
    expect(uploads[0].options.upsert).toBe(true);
  });

  it("strips MIME parameters before using it as the content type", async () => {
    const { storage, uploads } = fakeStorage();
    await mirrorTemplateSampleMedia({
      ...BASE,
      storage,
      download: fakeDownload(10, "image/png; charset=binary"),
    });
    expect(uploads[0].options.contentType).toBe("image/png");
    expect(uploads[0].path).toMatch(/\.png$/);
  });

  it("never touches the network for a non-URL handle", async () => {
    const download = fakeDownload(10);
    const { storage, uploads } = fakeStorage();
    const url = await mirrorTemplateSampleMedia({
      ...BASE,
      sampleUrl: "4::aW1hZ2U=",
      storage,
      download,
    });
    expect(url).toBeNull();
    expect(download).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it("refuses bytes over the bucket limit instead of a Storage error", async () => {
    const { storage, uploads } = fakeStorage();
    const url = await mirrorTemplateSampleMedia({
      ...BASE,
      storage,
      download: fakeDownload(MEDIA_MAX_BYTES + 1),
    });
    expect(url).toBeNull();
    expect(uploads).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("returns null rather than throwing when the CDN link has already expired", async () => {
    // The realistic failure: Meta re-signed the URL, so the one we saved
    // 403s. A sync must survive it.
    const { storage, uploads } = fakeStorage();
    const url = await mirrorTemplateSampleMedia({
      ...BASE,
      storage,
      download: vi.fn(async () => {
        throw new Error("Media download failed: 403");
      }),
    });
    expect(url).toBeNull();
    expect(uploads).toHaveLength(0);
  });

  it("returns null when Storage rejects the upload", async () => {
    const { storage } = fakeStorage({ message: "content type not allowed" });
    const url = await mirrorTemplateSampleMedia({
      ...BASE,
      storage,
      download: fakeDownload(100, "application/x-iso9660-image"),
    });
    expect(url).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("gives a usable URL for a video sample", async () => {
    const { storage, uploads } = fakeStorage();
    await mirrorTemplateSampleMedia({
      ...BASE,
      templateName: "demo_reel",
      storage,
      download: fakeDownload(500, "video/mp4"),
    });
    expect(uploads[0].path).toBe(
      `account-${ACCOUNT}/${TEMPLATE_SAMPLE_FOLDER}/demo_reel-en.mp4`,
    );
  });
});
