/**
 * Sync of every phone number registered under a connected WABA
 * (migration 047).
 *
 * Both connection paths — Meta Embedded Signup and the manual
 * credentials form — converge on POST /api/whatsapp/config, which
 * calls syncAccountPhoneNumbers() after a successful save. "Refresh
 * status" and the on-demand sync endpoint call it too, so one
 * function owns the whole catalog:
 *
 *   * upsert every number Meta returns from /{WABA_ID}/phone_numbers;
 *   * keep whichever number whatsapp_config currently sends with
 *     marked `is_active` (its id is the single source the send and
 *     webhook paths already read — nothing else has to change);
 *   * numbers that disappeared from Meta's list are soft-marked with
 *     `removed_at`, never deleted, so message history keyed by the id
 *     keeps resolving;
 *   * a transient Graph failure returns `{ ok: false }` instead of
 *     throwing — a failed sync must never flip the connection status.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { WhatsAppPhoneNumber } from '@/types'
import {
  listWabaPhoneNumbers,
  listAccessibleBusinesses,
  listWabasForBusiness,
  getWabaBusiness,
  MetaApiError,
  type WabaPhoneNumber,
} from './meta-api'

export interface SyncPhoneNumbersArgs {
  /** Service-role client — sync writes bypass RLS by design. */
  admin: SupabaseClient
  accountId: string
  wabaId: string
  /** Plaintext (already decrypted) token with Meta access. */
  accessToken: string
  /**
   * Current `whatsapp_config.phone_number_id` — the number the
   * account sends with. Stays `is_active` when Meta still lists it.
   */
  activePhoneNumberId: string | null
}

export interface SyncPhoneNumbersResult {
  ok: boolean
  /** Catalog after the sync — empty when `ok` is false. */
  numbers: WhatsAppPhoneNumber[]
  /** Meta listed zero numbers under the WABA (needs user action). */
  empty: boolean
  /** The previously-active number is no longer under the WABA. */
  activeMissing: boolean
  /**
   * WABAs actually read from Meta this run. When this is just the
   * connected one, portfolio discovery failed (missing
   * business_management scope or app-access limits) — the UI surfaces
   * the count so a "where are my old numbers?" answer is one look away
   * instead of guesswork.
   */
  wabasScanned: string[]
  error?: string
}

/**
 * Meta error codes worth one more attempt: 1/2 (unknown/service
 * temporary), 4/32/61 (rate limiting / temporary block). Plus 429 /
 * 5xx statuses and plain network failures (fetch throws TypeError).
 */
function isTransientMetaError(err: unknown): boolean {
  if (err instanceof MetaApiError) {
    return (
      err.httpStatus === 429 ||
      err.httpStatus >= 500 ||
      (err.code !== null && [1, 2, 4, 32, 61].includes(err.code))
    )
  }
  return err instanceof TypeError
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * listWabaPhoneNumbers with exponential backoff for transient Meta
 * errors. Non-transient ones (bad token, wrong WABA) fail immediately
 * — retrying a 190 just delays the actionable error.
 */
async function listWithRetry(
  args: { wabaId: string; accessToken: string },
  attempts = 3,
): Promise<WabaPhoneNumber[]> {
  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await listWabaPhoneNumbers(args)
    } catch (err) {
      lastErr = err
      if (!isTransientMetaError(err) || attempt === attempts - 1) throw err
      await sleep(500 * 2 ** attempt)
    }
  }
  throw lastErr
}

/**
 * Expand the single connected WABA into every sibling WhatsApp Business
 * Account under the same Business Portfolio. This is the whole point of
 * the fix: Meta's Embedded Signup returns only the ONE WABA the session
 * landed on, so numbers that were verified long ago under a DIFFERENT
 * WABA of the same portfolio never appeared. Walking
 * `/me/businesses → /{portfolio}/whatsapp_business_accounts` finds them.
 *
 * Best-effort: any failure (e.g. the token lacks business_management
 * scope) degrades to just the connected WABA — the previous behaviour —
 * so discovery can never make a working connection worse.
 * Exported so the Embedded Signup callback can offer a portfolio-wide
 * number picker before any config row exists.
 */
export async function discoverAccountWabaIds(args: {
  wabaId: string
  accessToken: string
}): Promise<string[]> {
  const { wabaId, accessToken } = args
  const ids = new Set<string>()
  try {
    let businesses = await listAccessibleBusinesses({ accessToken })
    if (businesses.length === 0) {
      // Token can't enumerate portfolios from /me — ask the WABA node
      // which portfolio owns it and walk that one.
      businesses = await getWabaBusiness({ wabaId, accessToken })
    }
    for (const biz of businesses.slice(0, 10)) {
      try {
        const wabas = await listWabasForBusiness({ businessId: biz.id, accessToken })
        for (const w of wabas) ids.add(w.id)
      } catch (err) {
        console.error('[whatsapp/phone-numbers] WABA list under portfolio failed:', biz.id, err)
      }
    }
  } catch (err) {
    console.error('[whatsapp/phone-numbers] portfolio discovery failed:', err)
  }
  // Connected WABA first, then siblings, bounded to a sane page count.
  return [wabaId, ...[...ids].filter((i) => i !== wabaId)].slice(0, 20)
}

/**
 * Fetch the WABA's full number list and reconcile it into
 * `whatsapp_phone_numbers`. Never throws — callers get a structured
 * result and treat `ok: false` as a soft (logged, non-fatal) failure.
 */
export async function syncAccountPhoneNumbers(
  args: SyncPhoneNumbersArgs,
): Promise<SyncPhoneNumbersResult> {
  const { admin, accountId, wabaId, accessToken, activePhoneNumberId } = args

  const emptyResult: SyncPhoneNumbersResult = {
    ok: false,
    numbers: [],
    empty: false,
    activeMissing: false,
    wabasScanned: [],
  }

  // Walk the whole portfolio, not just the connected WABA, so numbers
  // verified under sibling WhatsApp Business Accounts are surfaced too.
  const wabaIds = await discoverAccountWabaIds({ wabaId, accessToken })

  type FetchedNumber = WabaPhoneNumber & { sourceWabaId: string }
  const fetched: FetchedNumber[] = []
  // WABAs we actually read this run. Removals are only reconciled against
  // these, so a sibling we couldn't reach never has its numbers erased.
  const scannedWabaIds = new Set<string>()
  for (const w of wabaIds) {
    try {
      const nums = await listWithRetry({ wabaId: w, accessToken })
      scannedWabaIds.add(w)
      for (const n of nums) fetched.push({ ...n, sourceWabaId: w })
    } catch (err) {
      console.error('[whatsapp/phone-numbers] Meta list failed for WABA', w, err)
      if (w === wabaId) {
        // The connected WABA itself is unreadable — that is a hard
        // failure the same way the old single-WABA sync failed.
        return {
          ...emptyResult,
          error: err instanceof Error ? err.message : 'phone number list failed',
        }
      }
      // A sibling we can't read is soft — keep whatever we already have
      // for it (its rows are simply not scanned, so not reconciled).
    }
  }

  const now = new Date().toISOString()
  const fetchedIds = new Set(fetched.map((n) => n.id))

  const { data: existingRows, error: existingError } = await admin
    .from('whatsapp_phone_numbers')
    .select('*')
    .eq('account_id', accountId)

  if (existingError) {
    console.error('[whatsapp/phone-numbers] catalog read failed:', existingError)
    return { ...emptyResult, error: existingError.message }
  }
  const existing = (existingRows ?? []) as WhatsAppPhoneNumber[]

  // Resolve which row should carry is_active. The number the account
  // sends with stays active UNLESS we scanned its WABA this run and
  // confirmed Meta dropped it. A number under a sibling we couldn't
  // re-read is left untouched (no evidence of removal) rather than
  // silently demoted because a transient discovery hiccup hid it.
  const activeRow = activePhoneNumberId
    ? existing.find((r) => r.phone_number_id === activePhoneNumberId)
    : undefined
  const activeWabaScanned = activeRow ? scannedWabaIds.has(activeRow.waba_id) : true
  const activeConfirmedGone =
    activePhoneNumberId != null &&
    activePhoneNumberId !== '' &&
    activeWabaScanned &&
    !fetchedIds.has(activePhoneNumberId)

  let desiredActive: string | null =
    activePhoneNumberId && !activeConfirmedGone ? activePhoneNumberId : null
  if (!desiredActive) {
    const surviving = existing.find(
      (r) =>
        r.is_active &&
        r.removed_at == null &&
        (fetchedIds.has(r.phone_number_id) || !scannedWabaIds.has(r.waba_id)),
    )
    if (surviving) desiredActive = surviving.phone_number_id
  }
  if (!desiredActive && fetched.length === 1) desiredActive = fetched[0].id

  // Demote before promoting: the partial unique index tolerates a
  // momentary zero-active but never two active rows.
  const { error: demoteError } = await admin
    .from('whatsapp_phone_numbers')
    .update({ is_active: false })
    .eq('account_id', accountId)
    .eq('is_active', true)
    .neq('phone_number_id', desiredActive ?? '')
  if (demoteError) {
    console.error('[whatsapp/phone-numbers] demote failed:', demoteError)
    return { ...emptyResult, error: demoteError.message }
  }

  if (fetched.length > 0) {
    const rows = fetched.map((n) => ({
      account_id: accountId,
      waba_id: n.sourceWabaId,
      phone_number_id: n.id,
      display_phone_number: n.display_phone_number ?? null,
      verified_name: n.verified_name ?? null,
      quality_rating: n.quality_rating ?? null,
      code_verification_status: n.code_verification_status ?? null,
      platform_type: n.platform_type ?? null,
      is_active: n.id === desiredActive,
      removed_at: null,
      last_synced_at: now,
    }))
    const { error: upsertError } = await admin
      .from('whatsapp_phone_numbers')
      .upsert(rows, { onConflict: 'account_id,phone_number_id' })
    if (upsertError) {
      console.error('[whatsapp/phone-numbers] upsert failed:', upsertError)
      return { ...emptyResult, error: upsertError.message }
    }
  }

  // Reconcile removals ONLY within WABAs we successfully scanned this
  // run: a row whose WABA wasn't scanned keeps its prior state, so a
  // sibling that was temporarily unreachable never loses its numbers.
  const removed = existing.filter(
    (r) =>
      scannedWabaIds.has(r.waba_id) &&
      !fetchedIds.has(r.phone_number_id) &&
      r.removed_at == null,
  )
  if (removed.length > 0) {
    const { error: removeError } = await admin
      .from('whatsapp_phone_numbers')
      .update({ removed_at: now, is_active: false, last_synced_at: now })
      .eq('account_id', accountId)
      .in(
        'id',
        removed.map((r) => r.id),
      )
    if (removeError) {
      console.error('[whatsapp/phone-numbers] removal marking failed:', removeError)
      return { ...emptyResult, error: removeError.message }
    }
  }

  const { data: finalRows, error: finalError } = await admin
    .from('whatsapp_phone_numbers')
    .select('*')
    .eq('account_id', accountId)
    .order('is_active', { ascending: false })
    .order('display_phone_number', { ascending: true, nullsFirst: false })

  if (finalError) {
    console.error('[whatsapp/phone-numbers] final read failed:', finalError)
    return { ...emptyResult, error: finalError.message }
  }

  return {
    ok: true,
    numbers: (finalRows ?? []) as WhatsAppPhoneNumber[],
    empty: fetched.length === 0,
    activeMissing: activeConfirmedGone,
    wabasScanned: [...scannedWabaIds],
  }
}

/**
 * Clear the whole catalog for an account — used by Disconnect and
 * "Reset Configuration" so no synced number survives the connection.
 * Takes any client: RLS (admin-only writes) applies when called with
 * the user's session, service-role bypasses it. Failure is logged,
 * not thrown — the config row is already gone and a stale catalog
 * must never block a disconnect.
 */
export async function clearAccountPhoneNumbers(
  supabase: SupabaseClient,
  accountId: string,
): Promise<void> {
  const { error } = await supabase
    .from('whatsapp_phone_numbers')
    .delete()
    .eq('account_id', accountId)
  if (error) {
    console.error('[whatsapp/phone-numbers] catalog clear failed:', error)
  }
}

/**
 * Flip the account's active number. Both writes go through the
 * service-role client: the catalog flag and the mirror on
 * whatsapp_config.phone_number_id — the field send paths and the
 * inbound webhook already key on, so switching active here switches
 * everything downstream with zero changes elsewhere.
 *
 * Returns an error string when the number isn't in the account's
 * catalog (or was removed on Meta's side), or when another account
 * already claims it via whatsapp_config's global UNIQUE.
 */
export async function setActivePhoneNumber(args: {
  admin: SupabaseClient
  accountId: string
  phoneNumberId: string
}): Promise<{ ok: boolean; error?: string }> {
  const { admin, accountId, phoneNumberId } = args

  const { data: target, error: targetError } = await admin
    .from('whatsapp_phone_numbers')
    .select('id, waba_id, removed_at, is_active')
    .eq('account_id', accountId)
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle()

  if (targetError) {
    console.error('[whatsapp/phone-numbers] active lookup failed:', targetError)
    return { ok: false, error: 'Failed to load phone number catalog' }
  }
  if (!target) return { ok: false, error: 'Phone number is not in this account’s synced catalog' }
  if (target.removed_at) {
    return { ok: false, error: 'This number was removed from Meta — pick one of the current numbers' }
  }
  if (target.is_active) return { ok: true }

  // whatsapp_config.phone_number_id is globally UNIQUE (migration 013)
  // and the webhook routes inbound on it — a second account using the
  // same number would drop every inbound message (issue #136).
  const { data: claimed } = await admin
    .from('whatsapp_config')
    .select('account_id')
    .eq('phone_number_id', phoneNumberId)
    .neq('account_id', accountId)
    .maybeSingle()
  if (claimed) {
    return {
      ok: false,
      error: 'This phone number is linked to another account and cannot be activated here',
    }
  }

  // Mirror the config row FIRST: if that fails the catalog still
  // agrees with reality, and the partial unique index means the two
  // catalog updates below can never leave two active rows behind.
  // waba_id follows the active number's own WABA — when it lives under
  // a sibling account, registration/webhook/subscribed checks (keyed on
  // config.waba_id) must point at THAT WABA, not the one originally
  // connected. The business token already reached the sibling during
  // discovery, so it can send from it too.
  const { error: configError } = await admin
    .from('whatsapp_config')
    .update({
      phone_number_id: phoneNumberId,
      waba_id: target.waba_id,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)
  if (configError) {
    console.error('[whatsapp/phone-numbers] config mirror failed:', configError)
    return { ok: false, error: 'Failed to update the sending number' }
  }

  await admin
    .from('whatsapp_phone_numbers')
    .update({ is_active: false })
    .eq('account_id', accountId)
    .eq('is_active', true)
    .neq('phone_number_id', phoneNumberId)

  const { error: activateError } = await admin
    .from('whatsapp_phone_numbers')
    .update({ is_active: true })
    .eq('account_id', accountId)
    .eq('phone_number_id', phoneNumberId)

  if (activateError) {
    console.error('[whatsapp/phone-numbers] activate failed:', activateError)
    return { ok: false, error: 'Failed to mark the number active' }
  }

  return { ok: true }
}
