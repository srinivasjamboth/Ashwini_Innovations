// ============================================================
// Carousel campaign media — upload each card asset to Meta ONCE
// per campaign (per phone number), never per recipient.
//
// A carousel send must carry one media reference per card, and every
// recipient of a campaign receives the SAME cards, so re-uploading per
// recipient would multiply Meta's media-upload rate by the audience
// size for nothing. This module resolves the campaign's card media
// before the fan-out starts and stamps the result into every
// recipient's `messageParams.carousel.media`:
//
//   1. Cache hit  — `whatsapp_media_ids` (migration 059) already holds
//      a live Meta id for (account, phone_number_id, media_url).
//   2. Cache miss — download the bytes from our own durable storage URL
//      (the chat-media bucket is public, so the URL is fetchable) and
//      POST /{phone_number_id}/media once, recording the id + expiry.
//   3. Failure    — fall back to the public link, the same shape the
//      media-header send path already hands Meta for IMAGE/VIDEO
//      headers. A send then fails loudly only if Meta rejects links too.
//
// `forceRefresh` re-uploads past the cache — `deliverBroadcast` uses it
// for one retry when Meta rejects an id we cached (an expired or
// pruned media object), so a stale cache never dooms a campaign.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { uploadMedia } from '@/lib/whatsapp/meta-api';
import { carouselOf, type CarouselSendValues } from '@/lib/whatsapp/carousel';
import { MEDIA_HEADER_SPECS } from '@/lib/whatsapp/media-header-types';
import type { MessageTemplate } from '@/types';

/**
 * Meta keeps uploaded media briefly; caching for a week (well inside
 * that) with a forced-refresh retry on rejection means a long-running
 * or resumed campaign re-uploads at most once per asset per pass
 * instead of on every send.
 */
const MEDIA_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Card uploads are independent — three in flight keeps a pass quick. */
const UPLOAD_CONCURRENCY = 3;

export interface CarouselCampaignMediaArgs {
  accountId: string;
  phoneNumberId: string;
  accessToken: string;
  template: MessageTemplate | null | undefined;
  /** Skip the cache and re-upload every card (refresh-on-rejected). */
  forceRefresh?: boolean;
}

/**
 * Resolve one `{ id }` (or `{ link }` fallback) entry per card,
 * parallel to the template's card order — the shape
 * `CarouselSendValues.media` expects. Returns `null` for a template
 * that is not a carousel or has no card assets, so callers can apply it
 * unconditionally.
 */
export async function ensureCarouselCampaignMedia(
  db: SupabaseClient,
  args: CarouselCampaignMediaArgs,
): Promise<CarouselSendValues['media'] | null> {
  const data = carouselOf(args.template ?? null);
  if (!data) return null;

  const urls = data.cards.map((card) => card.media_url?.trim() || '');
  const out: NonNullable<CarouselSendValues['media']> = data.cards.map(() => ({}));

  // ── 1. Cache pass: live ids for every card URL in one query ────────
  const distinctUrls = [...new Set(urls.filter(Boolean))];
  const cached = new Map<string, string>();
  if (distinctUrls.length > 0 && !args.forceRefresh) {
    const { data: rows } = await db
      .from('whatsapp_media_ids')
      .select('media_url, meta_media_id, expires_at')
      .eq('account_id', args.accountId)
      .eq('phone_number_id', args.phoneNumberId)
      .in('media_url', distinctUrls);
    const now = Date.now();
    for (const row of rows ?? []) {
      const expires = Date.parse(String(row.expires_at ?? ''));
      if (Number.isFinite(expires) && expires > now) {
        cached.set(String(row.media_url), String(row.meta_media_id));
      }
    }
  }

  // Cards still needing an upload (cache miss). Cards with no URL at
  // all fall straight through to `{}` — the send builder throws for
  // that card with a message naming it, exactly as before.
  const pending = distinctUrls.filter((url) => !cached.has(url));

  // ── 2. Upload pass: bounded-concurrency fetch + POST /media ────────
  const linkFallback = new Map<string, string>();
  const uploadOne = async (url: string): Promise<void> => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`storage returned HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());

      const spec = MEDIA_HEADER_SPECS[data.media_format];
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim();
      const mimeType =
        contentType && spec.mimeTypes.includes(contentType)
          ? contentType
          : spec.mimeTypes[0];
      const ext =
        spec.extensions[mimeType] ??
        url.split('?')[0].split('.').pop()?.toLowerCase() ??
        'bin';
      const cardIndex = urls.indexOf(url);
      const fileName = `carousel-${cardIndex + 1}-${data.cards[cardIndex]?.media_filename || 'card'}.${ext}`.replace(/\.[^.]+$/, `.${ext}`);

      const { mediaId } = await uploadMedia({
        phoneNumberId: args.phoneNumberId,
        accessToken: args.accessToken,
        kind: data.media_format,
        fileName,
        mimeType,
        bytes,
      });
      cached.set(url, mediaId);

      // Best-effort cache write — RLS blocks member writes below admin
      // and the service-role pass bypasses it anyway; a missed insert
      // only costs a re-upload on the next pass.
      await db.rpc('record_whatsapp_media_id', {
        p_account_id: args.accountId,
        p_phone_number_id: args.phoneNumberId,
        p_media_url: url,
        p_media_kind: data.media_format,
        p_meta_media_id: mediaId,
        p_expires_at: new Date(Date.now() + MEDIA_ID_TTL_MS).toISOString(),
      });
    } catch (error) {
      // Upload failed — fall back to the public link Meta can fetch
      // itself (the existing media-header pattern).
      console.warn(
        '[carousel-send-media] upload failed, falling back to link:',
        error instanceof Error ? error.message : error,
      );
      linkFallback.set(url, url);
    }
  };

  for (let i = 0; i < pending.length; i += UPLOAD_CONCURRENCY) {
    await Promise.all(pending.slice(i, i + UPLOAD_CONCURRENCY).map(uploadOne));
  }

  // ── 3. Assemble, parallel to the template's cards ──────────────────
  urls.forEach((url, index) => {
    if (!url) return;
    const id = cached.get(url);
    if (id) out[index] = { id };
    else if (linkFallback.has(url)) out[index] = { link: url };
  });
  return out.some((m) => m.id || m.link) ? out : null;
}

/**
 * True when a Meta send error looks like a media-rejection (expired or
 * unknown id, unfetchable link) rather than a content/parameter error —
 * the signal `deliverBroadcast` uses to force-refresh the campaign's
 * media ids and retry the recipient once. Matches Meta's 1310xx/1312xx
 * media error family plus the id-text signatures in their messages.
 */
export function isCarouselMediaRejection(message: string): boolean {
  const codeMatch = message.match(/\b(?:13\d{4})\b/);
  if (codeMatch) {
    const code = Number(codeMatch[0]);
    // 131026 media upload failed, 131049 unsupported media format,
    // 131200 media download failed, 131201–131202 invalid/expired id or
    // unsupported type, 131203 file too large for the fetched asset.
    if ([131026, 131049, 131200, 131201, 131202, 131203].includes(code)) {
      return true;
    }
  }
  const lower = message.toLowerCase();
  return (
    lower.includes('media download failed') ||
    lower.includes('the provided media object is invalid') ||
    lower.includes('could not find the media object') ||
    (lower.includes('media') && lower.includes('expired'))
  );
}
