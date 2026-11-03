import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import { isMirrorableSampleUrl } from '@/lib/whatsapp/template-sample-media'
import { fetchMediaForUpload, requireMetaAppId } from '@/lib/whatsapp/template-header-handle'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import type { CarouselCard } from '@/types'

/**
 * Carousel cards need the same treatment as a media template header:
 * Meta accepts ONLY an `example.header_handle` for a card's image/video
 * sample, never a public URL. This helper walks the payload's cards and
 * derives a handle for every card that has an asset URL but no handle
 * yet, so a first submit and a re-submit of an unchanged card both work.
 *
 * Cards upload in parallel (bounded) because a 10-card carousel would
 * otherwise serialise ten fetch + two-step-upload round trips in front of
 * the submit request, and Meta's own 429 on template creates is far more
 * likely to time the route out first.
 */

/** Three in flight at a time — Meta's media endpoints throttle hard. */
const CARD_UPLOAD_CONCURRENCY = 3

/** One retry per card: a dropped fetch is a nuisance, not a rejection. */
const CARD_UPLOAD_ATTEMPTS = 2

async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      await fn(items[index], index)
    }
  })
  await Promise.all(workers)
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < CARD_UPLOAD_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Card media upload failed.')
}

/**
 * Does this card still need a Resumable-Upload handle?
 *
 * A stored value that is really an http(s) URL does not count: "Sync from
 * Meta" sees Meta's signed CDN sample in `header_handle`, and submitting
 * that back fails with an opaque "Invalid parameter" — so the card is
 * re-uploaded from our own durable copy instead.
 */
function needsHandle(card: CarouselCard): boolean {
  if (card.media_handle && !isMirrorableSampleUrl(card.media_handle)) return false
  return Boolean(card.media_url?.trim())
}

/**
 * No-op unless the payload is a carousel with at least one card missing a
 * handle. Throws with the card number so the builder can point the author
 * straight at the offending card.
 */
export async function ensureCarouselCardHandles(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  if (payload.header_type !== 'carousel') return
  const data = payload.carousel
  if (!data || !Array.isArray(data.cards) || data.cards.length === 0) return

  const pending = data.cards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => needsHandle(card))
  if (pending.length === 0) return

  const appId = requireMetaAppId()
  const format = data.media_format

  // Two cards often share one asset (a duplicate), and the handle is
  // per-file, so fetch + upload each distinct URL once per submit.
  const inflight = new Map<string, Promise<string>>()
  const handleFor = (url: string): Promise<string> => {
    const existing = inflight.get(url)
    if (existing) return existing
    const next = withRetry(async () => {
      const { bytes, mimeType, fileName } = await fetchMediaForUpload(url, format)
      const { handle } = await uploadResumableMedia({ appId, accessToken, fileName, mimeType, bytes })
      return handle
    })
    inflight.set(url, next)
    return next
  }

  await mapPool(pending, CARD_UPLOAD_CONCURRENCY, async ({ card, index }) => {
    try {
      card.media_handle = await handleFor(card.media_url as string)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Card media upload failed.'
      throw new Error(`Card ${index + 1}: ${message}`)
    }
  })
}
