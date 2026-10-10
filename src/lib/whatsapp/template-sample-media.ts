import { downloadMedia } from "./meta-api";
import { extensionForMime } from "@/lib/media/filename";
import { buildMediaPath, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";
import { MIRROR_BUCKET, type MirrorStorage } from "./mirror-inbound-media";

/**
 * Copy a template's header-sample media out of Meta's CDN and into our
 * own public bucket, so the template stays sendable.
 *
 * The problem this solves: `GET /{waba}/message_templates` returns the
 * approved header sample in `components[].example.header_handle[]` as a
 * **signed scontent.whatsapp.net URL**, and Meta re-signs it on every
 * read. The signature is not stable, so a URL saved from one sync is
 * dead on the next — it returns HTTP 403 within minutes.
 *
 * That URL is also the ONLY media reference a synced template has. At
 * send time `buildSendComponents` needs a `link` or a real `/media`
 * upload `id` for every IMAGE/VIDEO/DOCUMENT header
 * (`template-send-builder.ts`), and it deliberately refuses to reuse
 * `header_handle`, because that field is a creation-time sample, not a
 * send-time media id. So a template that only ever arrived through
 * "Sync from Meta" had a media header in Meta's catalogue, nothing
 * sendable in our row, and every send failed.
 *
 * Mirroring gives the row a URL we control: the `chat-media` bucket is
 * public, so Meta fetches it at send time, and it never expires.
 *
 * Best-effort by design, and returns `null` instead of throwing. A sync
 * that aborts because one image wouldn't download is worse than one
 * template that keeps its old (empty) media field — the caller reports
 * it as a warning and the other templates still land.
 */

/**
 * Third path segment inside the account folder, so a bucket listing
 * separates template samples from chat attachments. The bucket's write
 * policies only match the FIRST segment (`account-<id>`, migration 023),
 * so nesting is free.
 */
export const TEMPLATE_SAMPLE_FOLDER = "template-headers";

/**
 * Does this URL point at our own public bucket?
 *
 * Used to skip re-mirroring a template we already copied: the object is
 * durable and its path is stable, so once `header_media_url` is ours,
 * later syncs have no reason to pull the same bytes off Meta's CDN
 * again. Matches on the public-object route shape rather than the host,
 * so a custom domain or a project rename doesn't silently re-enable the
 * download.
 */
export function isMirroredMediaUrl(value?: string | null): boolean {
  return (
    !!value && value.includes(`/storage/v1/object/public/${MIRROR_BUCKET}/`)
  );
}

/** Hosts that serve Meta's signed template samples. */
const META_CDN_HOSTS = [
  "whatsapp.net",
  "fbcdn.net",
  "facebook.net",
  "fbsbx.com",
];

/**
 * Is this URL Meta's own (expiring) CDN link?
 *
 * Used to decide whether a stored `header_media_url` is worth keeping.
 * Our mirrored copy is durable and an operator's own CDN link is
 * deliberate, so both are left alone; anything pointing at Meta is the
 * broken legacy state and gets re-mirrored.
 */
export function isMetaCdnSampleUrl(value?: string | null): boolean {
  if (!isMirrorableSampleUrl(value)) return false;
  try {
    const { hostname } = new URL(value);
    return META_CDN_HOSTS.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
  } catch {
    return false;
  }
}

/**
 * Should this row's header media be (re)mirrored?
 *
 * `false` only when the row already holds a URL that will still resolve
 * later — our own bucket copy, or a link the operator set on purpose.
 * `true` for an empty field (every template that has only ever come from
 * "Sync from Meta") and for a Meta CDN link, whose signature is rotated
 * on each read and therefore cannot be relied on.
 */
export function needsMediaMirror(value?: string | null): boolean {
  if (!value) return true;
  if (isMirroredMediaUrl(value)) return false;
  return isMetaCdnSampleUrl(value);
}

/** Header formats that carry media and therefore need mirroring. */
const MEDIA_HEADER_TYPES = new Set(["image", "video", "document"]);

export function isMediaHeaderType(headerType?: string | null): boolean {
  return !!headerType && MEDIA_HEADER_TYPES.has(headerType.toLowerCase());
}

/**
 * Is this `example.header_handle` value something we can actually fetch?
 *
 * Meta currently always returns a signed URL here, but the field is
 * named "handle" and its sibling in the creation payload is an opaque
 * `4::aW1...` string, so treat anything that isn't an http(s) URL as
 * "not mirrorable" rather than handing a bogus link to Storage.
 */
export function isMirrorableSampleUrl(value?: string | null): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Object name for a template's sample inside the account folder.
 *
 * Keyed on name + language rather than a timestamp: a template's media
 * does not change between syncs, so re-running sync rewrites the same
 * object instead of filling the bucket with a new copy every click.
 * Language is part of the key because Meta versions a template per
 * language and each version carries its own sample.
 */
export function templateSampleObjectPath(args: {
  accountId: string;
  templateName: string;
  language: string;
  mimeType: string | null;
}): string {
  const ext = extensionForMime(args.mimeType);
  const name = `${args.templateName}-${args.language}.${ext}`;
  return buildMediaPath(
    args.accountId,
    name,
    null,
    TEMPLATE_SAMPLE_FOLDER,
  );
}

export interface MirrorTemplateSampleArgs {
  /** `supabase.storage` for the syncing user — bucket RLS scopes the write. */
  storage: MirrorStorage;
  accountId: string;
  templateName: string;
  language: string;
  /** Meta's signed sample URL, straight off `example.header_handle[0]`. */
  sampleUrl: string;
  accessToken: string;
  /** Injected in tests. */
  download?: typeof downloadMedia;
}

/**
 * Download the sample from Meta's CDN and store it in `chat-media`.
 *
 * @returns the durable public URL to save as `header_media_url`, or
 *          `null` when the mirror was skipped or failed.
 */
export async function mirrorTemplateSampleMedia(
  args: MirrorTemplateSampleArgs,
): Promise<string | null> {
  const {
    storage,
    accountId,
    templateName,
    language,
    sampleUrl,
    accessToken,
    download = downloadMedia,
  } = args;

  if (!isMirrorableSampleUrl(sampleUrl)) return null;

  try {
    const { buffer, contentType } = await download({
      downloadUrl: sampleUrl,
      accessToken,
    });

    // Same ceiling as inbound mirroring: the bucket refuses anything
    // past 16 MB, so say so here instead of surfacing Storage's own
    // opaque limit error.
    if (buffer.byteLength > MEDIA_MAX_BYTES) {
      console.warn(
        `[template-media] skipping ${templateName}/${language}: downloaded ${buffer.byteLength} bytes, over the ${MEDIA_MAX_BYTES}-byte bucket limit`,
      );
      return null;
    }

    const mimeType = contentType?.split(";")[0]?.trim().toLowerCase() || null;
    const path = templateSampleObjectPath({
      accountId,
      templateName,
      language,
      mimeType,
    });

    // `upsert: true` because the path is stable across syncs by design.
    const { error } = await storage.from(MIRROR_BUCKET).upload(path, buffer, {
      contentType: mimeType ?? "application/octet-stream",
      cacheControl: "3600",
      upsert: true,
    });
    if (error) {
      console.warn(
        `[template-media] upload failed for ${templateName}/${language}:`,
        error.message,
      );
      return null;
    }

    const {
      data: { publicUrl },
    } = storage.from(MIRROR_BUCKET).getPublicUrl(path);
    return publicUrl || null;
  } catch (error) {
    console.warn(
      `[template-media] could not mirror ${templateName}/${language}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
