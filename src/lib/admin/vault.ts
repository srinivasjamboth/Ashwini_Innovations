/**
 * Plan Vault — server module for /ashwini-control/plan-vault.
 *
 * One row per SUBSCRIPTION record (plan history), computed straight
 * from the 048/049 billing tables via the service-role client. No mock
 * data anywhere: when the billing schema isn't applied yet the bundle
 * honestly reports `available: false` and the UI shows the empty state.
 *
 * The effective status shown here is the SAME shared function the
 * enforcement engine and (after the Part 3.2 rewiring) Pulse / Member
 * Ledger use — `computeEffectiveStatus` from lib/plans/entitlements —
 * wrapped in `computeVaultStatus` for the five-way badge vocabulary
 * (Active / Trial / Past due / Cancelled / Expired).
 *
 * Aggregation notes (spec Part 7 "aggregate in the database"): the
 * candidate scan runs as a handful of parallel queries; the day-window,
 * search and effective-status semantics are then applied in ONE place
 * in this module so list, detail and summary can never disagree. The
 * dataset is admin-scale (one row per paying customer), and the scan is
 * hard-capped so a pathological table can't balloon the request.
 */

import { supabaseAdmin } from './supabase-admin'
import { ADMIN_TIMEZONE, LEDGER_MIN_QUERY_LENGTH, VAULT_SCAN_CAP } from './constants'
import { computeEffectiveStatus, getEntitlements, invalidateEntitlements } from '@/lib/plans/entitlements'
import type { SubscriptionStatus } from '@/lib/plans/types'

/* ------------------------------------------------------------------ *
 * Effective status — the Vault's five-way display vocabulary derived
 * from the ONE shared computeEffectiveStatus (spec Part 3.2).
 * ------------------------------------------------------------------ */

export type VaultStatus = 'active' | 'trial' | 'past_due' | 'cancelled' | 'expired'

export function computeVaultStatus(
  sub:
    | { status: SubscriptionStatus | string; current_period_end: string | null; trial_end: string | null }
    | null
    | undefined,
  now: Date = new Date(),
): VaultStatus {
  if (!sub) return 'expired'
  const eff = computeEffectiveStatus(
    {
      status: sub.status as SubscriptionStatus,
      current_period_end: sub.current_period_end,
      trial_end: sub.trial_end,
    },
    now,
  )
  if (eff === 'trialing') return 'trial'
  if (eff === 'active') return sub.status === 'past_due' ? 'past_due' : 'active'
  // expired
  return sub.status === 'canceled' ? 'cancelled' : 'expired'
}

/* ------------------------------------------------------------------ *
 * Timezone day boundaries (Asia/Kolkata by default, inclusive days).
 * ------------------------------------------------------------------ */

/** Offset (ms, positive east) of `tz` at the given instant. */
export function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p: Record<string, string> = {}
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  )
  // Round to whole minutes — offsets are never sub-minute.
  return Math.round((asUtc - instant.getTime()) / 60_000) * 60_000
}

/** UTC ms instant of 00:00:00.000 (inclusive start) of `YYYY-MM-DD` in `tz`. */
export function dayStartUtcMs(dateStr: string, tz: string = ADMIN_TIMEZONE): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return null
  const utcNoon = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
  const offset = tzOffsetMs(new Date(utcNoon), tz)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - offset
}

/** UTC ms instant of the end of `YYYY-MM-DD` in `tz` (exclusive bound =
 *  start of the next day). Returns null for malformed input. */
export function dayEndExclusiveUtcMs(dateStr: string, tz: string = ADMIN_TIMEZONE): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return null
  // Next CALENDAR day, then its tz-local start — deriving "next day"
  // from dayStartUtcMs would be wrong: that instant is 00:00 in `tz`,
  // but an earlier UTC day whose UTC date would repeat this day.
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  next.setUTCDate(next.getUTCDate() + 1)
  return dayStartUtcMs(next.toISOString().slice(0, 10), tz)
}

/** Inclusive window [from, to] as UTC instants; open ends stay open. */
export function resolveRangeMs(
  from: string | null,
  to: string | null,
  tz: string = ADMIN_TIMEZONE,
): { startMs: number | null; endExclusiveMs: number | null } {
  const startMs = from ? dayStartUtcMs(from, tz) : null
  const endExclusiveMs = to ? dayEndExclusiveUtcMs(to, tz) : null
  return { startMs, endExclusiveMs }
}

/* ------------------------------------------------------------------ *
 * Query parsing (URL search params → typed, validated query).
 * ------------------------------------------------------------------ */

export const VAULT_PAGE_SIZES = [10, 25, 50, 100] as const
export type VaultSortField = 'created' | 'expires' | 'amount' | 'plan'
export type VaultDateField = 'subscribed' | 'expires' | 'registered'

export interface VaultQuery {
  q: string
  page: number
  pageSize: number
  sortBy: VaultSortField
  sortDir: 'asc' | 'desc'
  plans: string[]
  billing: 'monthly' | 'yearly' | ''
  statuses: VaultStatus[]
  dateField: VaultDateField
  from: string | null
  to: string | null
}

const SORT_FIELDS: VaultSortField[] = ['created', 'expires', 'amount', 'plan']
const DATE_FIELDS: VaultDateField[] = ['subscribed', 'expires', 'registered']
const STATUSES: VaultStatus[] = ['active', 'trial', 'past_due', 'cancelled', 'expired']

function csv(raw: string | null): string[] {
  return raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : []
}

/** Parse request params. Never throws — anything invalid falls back to
 *  the default view (newest subscription first, page 1, 25/page). */
export function parseVaultQuery(sp: URLSearchParams): VaultQuery {
  const sortBy = sp.get('sort')
  const sortDir = sp.get('dir')
  const pageSize = Number(sp.get('pageSize') ?? '25')
  const statuses = csv(sp.get('status')).filter((s): s is VaultStatus =>
    STATUSES.includes(s as VaultStatus),
  )
  const billing = sp.get('billing')
  const dateField = sp.get('dateField')
  return {
    q: (sp.get('q') ?? '').trim(),
    page: Math.max(1, Math.floor(Number(sp.get('page') ?? '1')) || 1),
    pageSize: (VAULT_PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 25,
    sortBy: SORT_FIELDS.includes(sortBy as VaultSortField) ? (sortBy as VaultSortField) : 'created',
    sortDir: sortDir === 'asc' ? 'asc' : 'desc',
    plans: csv(sp.get('plan')),
    billing: billing === 'monthly' || billing === 'yearly' ? billing : '',
    statuses,
    dateField: DATE_FIELDS.includes(dateField as VaultDateField)
      ? (dateField as VaultDateField)
      : 'subscribed',
    from: /^\d{4}-\d{2}-\d{2}$/.test(sp.get('from') ?? '') ? sp.get('from') : null,
    to: /^\d{4}-\d{2}-\d{2}$/.test(sp.get('to') ?? '') ? sp.get('to') : null,
  }
}

/* ------------------------------------------------------------------ *
 * Row / bundle DTOs (what the JSON endpoints return).
 * ------------------------------------------------------------------ */

export interface VaultRowDto {
  subscriptionId: string
  accountId: string
  userId: string
  customer: { name: string; email: string; phone: string | null; registeredAt: string | null }
  planId: string
  planName: string
  subscribedOn: string
  expiresOn: string | null
  amount: number
  billingCycle: string
  status: VaultStatus
  /** Latest payment_transactions state for this subscription. */
  paymentState: 'paid' | 'created' | 'failed' | 'refunded' | null
  gatewayLinked: boolean
  updatedAt: string
}

export interface VaultListDto {
  rows: VaultRowDto[]
  total: number
  page: number
  pageSize: number
  /** Filtered-range aggregates (spec 3.7) — never just the visible page. */
  summary: {
    subscriptionsInRange: number
    uniqueCustomers: number
    newRegistrationsInRange: number
  }
  available: boolean
  truncated: boolean
}

/* ------------------------------------------------------------------ *
 * Internals shared by list + detail
 * ------------------------------------------------------------------ */

const SUB_SELECT =
  'id,account_id,user_id,plan_id,status,billing_cycle,current_period_start,current_period_end,trial_end,trial_claimed_at,gateway,gateway_subscription_id,gateway_customer_id,created_at,updated_at,plans(name)'

interface SubRecord {
  id: string
  account_id: string
  user_id: string
  plan_id: string
  status: string
  billing_cycle: string
  current_period_start: string | null
  current_period_end: string | null
  trial_end: string | null
  trial_claimed_at: string | null
  gateway: string | null
  gateway_subscription_id: string | null
  gateway_customer_id: string | null
  created_at: string
  updated_at: string
  plans: { name: string } | { name: string }[] | null
}

function planNameOf(sub: SubRecord): string {
  const p = sub.plans
  return (Array.isArray(p) ? p[0]?.name : p?.name) ?? sub.plan_id
}

export function isMissingSchema(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  return (
    err.code === '42P01' ||
    err.code === 'PGRST205' ||
    err.code === 'PGRST202' ||
    /does not exist|not found/i.test(err.message ?? '')
  )
}

interface TxState {
  /** Amount of the latest SUCCESSFUL payment (rupees, NUMERIC(12,2)). */
  paidAmount: number | null
  /** Status of the most recent transaction of any kind. */
  latest: VaultRowDto['paymentState']
}

/** Fold the (small) payment_transactions table into per-subscription
 *  state in ONE pass. Amount precedence for a row is: latest paid txn →
 *  plan_prices for the row's cycle → 0. */
function foldTransactions(rows: { subscription_id: string | null; status: string; amount: number | null; created_at: string }[]): Map<string, TxState> {
  const map = new Map<string, TxState>()
  for (const t of rows) {
    if (!t.subscription_id) continue
    const cur = map.get(t.subscription_id) ?? { paidAmount: null, latest: null }
    // Transactions arrive oldest→newest, so "last write wins" is the latest.
    if (t.status === 'paid' && t.amount != null) cur.paidAmount = Number(t.amount)
    if (t.status === 'paid' || t.status === 'created' || t.status === 'failed' || t.status === 'refunded') {
      cur.latest = t.status as TxState['latest']
    }
    map.set(t.subscription_id, cur)
  }
  return map
}

export function resolveRowAmount(
  paidTxAmount: number | null,
  planPrice: number | null | undefined,
): number {
  if (paidTxAmount != null && Number.isFinite(paidTxAmount)) return paidTxAmount
  if (planPrice != null && Number.isFinite(Number(planPrice))) return Number(planPrice)
  return 0
}

/** en-IN currency formatting — the schema stores RUPEES (NUMERIC(12,2)
 *  in 048), never paise, so the value is formatted as-is. */
export function formatInr(rupees: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: Number.isInteger(rupees) ? 2 : 2,
    maximumFractionDigits: 2,
  }).format(rupees)
}

/* ------------------------------------------------------------------ *
 * GET list — search / filters / sort / paging / range summary.
 * ------------------------------------------------------------------ */

export async function getVaultList(ownerUserId: string, query: VaultQuery): Promise<VaultListDto> {
  const db = supabaseAdmin()

  // Parallel independent reads (spec Part 7).
  const subsP = db.from('subscriptions').select(SUB_SELECT).order('created_at', { ascending: false }).limit(VAULT_SCAN_CAP + 1)
  const txsP = db
    .from('payment_transactions')
    .select('subscription_id,status,amount,created_at')
    .order('created_at', { ascending: true })
    .limit(50_000)
  const pricesP = db.from('plan_prices').select('plan_id,billing_cycle,amount')
  const profilesP = db
    .from('profiles')
    .select('user_id,full_name,email,created_at' + (await profilesHavePhone() ? ',phone' : ''))
    .eq('account_role', 'owner')
    .limit(VAULT_SCAN_CAP * 2)

  const [subsRes, txsRes, pricesRes, profilesRes] = await Promise.all([subsP, txsP, pricesP, profilesP])

  if (isMissingSchema(subsRes.error)) {
    return emptyList(query, { available: false })
  }
  if (subsRes.error) throw subsRes.error

  const subs = ((subsRes.data ?? []) as unknown as SubRecord[])
    // The owner's own account never appears in the Vault.
    .filter((s) => s.user_id !== ownerUserId)
  const truncated = subs.length > VAULT_SCAN_CAP || Boolean(txsRes.error)
  const subRows = subs.slice(0, VAULT_SCAN_CAP)

  const txBySub = foldTransactions(
    (txsRes.data ?? []) as unknown as { subscription_id: string | null; status: string; amount: number | null; created_at: string }[],
  )
  const priceByKey = new Map<string, number>()
  for (const p of (pricesRes.data ?? []) as { plan_id: string; billing_cycle: string; amount: number }[]) {
    priceByKey.set(`${p.plan_id}:${p.billing_cycle}`, Number(p.amount))
  }
  type ProfileRec = { user_id: string; full_name: string; email: string; phone?: string | null; created_at: string }
  const profileByUser = new Map<string, ProfileRec>()
  for (const p of (profilesRes.data ?? []) as unknown as ProfileRec[]) profileByUser.set(p.user_id, p)

  // One candidate object per subscription with everything the
  // filters/sort/summary need — computed once, used everywhere.
  const now = new Date()
  const candidates = subRows.map((s) => {
    const profile = profileByUser.get(s.user_id)
    const tx = txBySub.get(s.id)
    return {
      sub: s,
      status: computeVaultStatus(s, now),
      expiresMs: s.current_period_end ? new Date(s.current_period_end).getTime() : s.trial_end ? new Date(s.trial_end).getTime() : null,
      registeredMs: profile?.created_at ? new Date(profile.created_at).getTime() : null,
      amount: resolveRowAmount(tx?.paidAmount ?? null, priceByKey.get(`${s.plan_id}:${s.billing_cycle}`)),
      haystack: `${profile?.full_name ?? ''} ${profile?.email ?? ''} ${profile?.phone ?? ''} ${planNameOf(s)}`.toLowerCase(),
      row: {
        subscriptionId: s.id,
        accountId: s.account_id,
        userId: s.user_id,
        customer: {
          name: profile?.full_name ?? '—',
          email: profile?.email ?? '—',
          phone: profile?.phone ?? null,
          registeredAt: profile?.created_at ?? null,
        },
        planId: s.plan_id,
        planName: planNameOf(s),
        subscribedOn: s.created_at,
        expiresOn: s.current_period_end ?? s.trial_end ?? null,
        amount: resolveRowAmount(tx?.paidAmount ?? null, priceByKey.get(`${s.plan_id}:${s.billing_cycle}`)),
        billingCycle: s.billing_cycle,
        status: computeVaultStatus(s, now),
        paymentState: tx?.latest ?? null,
        gatewayLinked: Boolean(s.gateway_subscription_id),
        updatedAt: s.updated_at,
      } satisfies VaultRowDto,
    }
  })

  // AND-combined filters.
  const needle = query.q.toLowerCase()
  const { startMs, endExclusiveMs } = resolveRangeMs(query.from, query.to)
  const planSet = new Set(query.plans)
  const statusSet = new Set(query.statuses)

  const filtered = candidates.filter((c) => {
    if (needle.length >= LEDGER_MIN_QUERY_LENGTH && !c.haystack.includes(needle)) return false
    if (planSet.size > 0 && !planSet.has(c.sub.plan_id)) return false
    if (query.billing && c.sub.billing_cycle !== query.billing) return false
    if (statusSet.size > 0 && !statusSet.has(c.status)) return false
    if (startMs !== null || endExclusiveMs !== null) {
      const inst =
        query.dateField === 'subscribed'
          ? new Date(c.sub.created_at).getTime()
          : query.dateField === 'expires'
            ? c.expiresMs
            : c.registeredMs
      if (inst === null) return false
      if (startMs !== null && inst < startMs) return false
      if (endExclusiveMs !== null && inst >= endExclusiveMs) return false
    }
    return true
  })

  // Sort (stable, id tie-break) then paginate.
  const dir = query.sortDir === 'asc' ? 1 : -1
  filtered.sort((a, b) => {
    let d = 0
    switch (query.sortBy) {
      case 'created':
        d = new Date(a.sub.created_at).getTime() - new Date(b.sub.created_at).getTime()
        break
      case 'expires':
        d = (a.expiresMs ?? -Infinity) - (b.expiresMs ?? -Infinity)
        break
      case 'amount':
        d = a.amount - b.amount
        break
      case 'plan':
        d = a.row.planName.localeCompare(b.row.planName)
        break
    }
    if (d === 0) d = a.sub.id < b.sub.id ? -1 : 1
    return d * dir
  })

  const total = filtered.length
  const start = (query.page - 1) * query.pageSize
  const rows = filtered.slice(start, start + query.pageSize).map((c) => c.row)

  // Range summary across ALL matching rows, same request (spec 3.7).
  const uniqueCustomers = new Set(filtered.map((c) => c.sub.account_id)).size
  return {
    rows,
    total,
    page: query.page,
    pageSize: query.pageSize,
    summary: {
      subscriptionsInRange: total,
      uniqueCustomers,
      newRegistrationsInRange: await countRegistrationsInRange(ownerUserId, query, needle),
    },
    available: true,
    truncated,
  }
}

function emptyList(query: VaultQuery, opts?: { available?: boolean }): VaultListDto {
  return {
    rows: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
    summary: { subscriptionsInRange: 0, uniqueCustomers: 0, newRegistrationsInRange: 0 },
    available: opts?.available ?? true,
    truncated: false,
  }
}

/** "New customer registrations in range" — DB-side count on profiles
 *  with the same day window / search term the list uses. Plan, cycle
 *  and status filters describe subscriptions, so they don't apply to a
 *  registration count (documented assumption). */
async function countRegistrationsInRange(
  ownerUserId: string,
  query: VaultQuery,
  needle: string,
): Promise<number> {
  let q = supabaseAdmin()
    .from('profiles')
    .select('user_id', { count: 'exact', head: true })
    .eq('account_role', 'owner')
    .neq('user_id', ownerUserId)
  const { startMs, endExclusiveMs } = resolveRangeMs(query.from, query.to)
  if (startMs !== null) q = q.gte('created_at', new Date(startMs).toISOString())
  if (endExclusiveMs !== null) q = q.lt('created_at', new Date(endExclusiveMs).toISOString())
  if (needle.length >= LEDGER_MIN_QUERY_LENGTH) {
    const safe = needle.replace(/,/g, '\\,')
    const clauses = [`full_name.ilike.%${safe}%`, `email.ilike.%${safe}%`]
    if (await profilesHavePhone()) clauses.push(`phone.ilike.%${safe}%`)
    q = q.or(clauses.join(','))
  }
  const { count, error } = await q
  if (error) {
    console.error('[admin-vault] registration count failed:', error.message)
    return 0
  }
  return count ?? 0
}

/** Whether the hosted profiles table has `phone` (same 044 caveat the
 *  metrics module guards against — a missing column errors the query). */
let phoneColCache: boolean | null = null
async function profilesHavePhone(): Promise<boolean> {
  if (phoneColCache !== null) return phoneColCache
  const { error } = await supabaseAdmin().from('profiles').select('phone').limit(1)
  phoneColCache = !error
  return phoneColCache
}

/* ------------------------------------------------------------------ *
 * GET plan options (filter chips + update panel selects).
 * ------------------------------------------------------------------ */

export interface VaultPlanOption {
  id: string
  name: string
  /** Plan description — the SAME `plans.tagline` column the public
   *  pricing cards render (lib/plans/catalog), so admin and pricing
   *  can never drift. */
  tagline: string | null
  prices: { monthly: number | null; yearly: number | null }
}

export async function getVaultPlanOptions(): Promise<{ plans: VaultPlanOption[]; available: boolean }> {
  const db = supabaseAdmin()
  const [plansRes, pricesRes] = await Promise.all([
    db.from('plans').select('id,name,tagline,sort,is_public').eq('is_public', true).order('sort', { ascending: true }),
    db.from('plan_prices').select('plan_id,billing_cycle,amount'),
  ])
  if (isMissingSchema(plansRes.error)) return { plans: [], available: false }
  if (plansRes.error) throw plansRes.error
  const priceMap = new Map<string, number>()
  for (const p of (pricesRes.data ?? []) as { plan_id: string; billing_cycle: string; amount: number }[]) {
    priceMap.set(`${p.plan_id}:${p.billing_cycle}`, Number(p.amount))
  }
  return {
    plans: ((plansRes.data ?? []) as { id: string; name: string; tagline: string | null }[]).map((p) => ({
      id: p.id,
      name: p.name,
      tagline: p.tagline ?? null,
      prices: {
        monthly: priceMap.get(`${p.id}:monthly`) ?? null,
        yearly: priceMap.get(`${p.id}:yearly`) ?? null,
      },
    })),
    available: !isMissingSchema(pricesRes.error),
  }
}

/* ------------------------------------------------------------------ *
 * GET detail — one subscription + plan limits/features + customer +
 * the customer's full subscription history (049 trigger/backfill rows).
 * ------------------------------------------------------------------ */

export interface VaultHistoryRow {
  id: string
  planName: string | null
  billingCycle: string | null
  started: string | null
  ends: string | null
  amount: number | null
  status: string | null
  source: string
  reference: string | null
  createdAt: string
  isCurrent: boolean
}

export interface VaultDetailDto {
  subscription: VaultRowDto & {
    periodStart: string | null
    trialEnd: string | null
    trialClaimedAt: string | null
    gateway: string | null
    gatewaySubscriptionId: string | null
    gatewayCustomerId: string | null
    cancelledOn: string | null
  }
  plan: {
    name: string
    prices: { monthly: number | null; yearly: number | null }
    /** straight from plan_limits — never hard-coded. */
    limits: { feature: string; value: number; period: string }[]
    /** straight from plan_features. */
    features: { feature: string; enabled: boolean }[]
  }
  /** Live usage vs limit from the shared entitlements engine. */
  usage: Record<string, number>
  customer: {
    userId: string
    name: string
    email: string
    phone: string | null
    accountName: string | null
    registeredAt: string | null
    lastActiveAt: string | null
  }
  history: {
    rows: VaultHistoryRow[]
    total: number
    paid: number
    trialOrOther: number
  }
}

export async function getVaultDetail(
  ownerUserId: string,
  subscriptionId: string,
): Promise<VaultDetailDto | null> {
  const db = supabaseAdmin()

  const subP = db
    .from('subscriptions')
    .select(SUB_SELECT)
    .eq('id', subscriptionId)
    .maybeSingle()
  const [subsRes] = await Promise.all([subP])
  if (isMissingSchema(subsRes.error)) return null
  if (subsRes.error) throw subsRes.error
  const sub = subsRes.data as SubRecord | null
  if (!sub || sub.user_id === ownerUserId) return null

  const now = new Date()
  const [{ data: txs }, { data: prices }, { data: profile }, { data: account }, { data: history }, entitlements] =
    await Promise.all([
      db
        .from('payment_transactions')
        .select('subscription_id,status,amount,created_at')
        .eq('subscription_id', subscriptionId)
        .order('created_at', { ascending: true }),
      db.from('plan_prices').select('plan_id,billing_cycle,amount').eq('plan_id', sub.plan_id),
      profilesHavePhone().then((hasPhone) =>
        db
          .from('profiles')
          .select(hasPhone ? 'user_id,full_name,email,phone,created_at,updated_at' : 'user_id,full_name,email,created_at,updated_at')
          .eq('user_id', sub.user_id)
          .maybeSingle(),
      ),
      db.from('accounts').select('id,name').eq('id', sub.account_id).maybeSingle(),
      db
        .from('subscription_history')
        .select('id,subscription_id,plan_name_snapshot,billing_cycle,amount,status,period_start,period_end,source,admin_action_id,created_at')
        .eq('account_id', sub.account_id)
        .order('created_at', { ascending: false })
        .limit(500),
      // Limits, features and CURRENT usage vs limit — the exact engine
      // the customer's own enforcement reads, so the page can't drift.
      getEntitlements(sub.account_id, { admin: db }),
    ])

  const txBySub = foldTransactions(
    (txs ?? []) as unknown as { subscription_id: string | null; status: string; amount: number | null; created_at: string }[],
  )
  const priceMap = new Map<string, number>()
  for (const p of (prices ?? []) as { billing_cycle: string; amount: number }[]) {
    priceMap.set(p.billing_cycle, Number(p.amount))
  }
  const tx = txBySub.get(subscriptionId)
  const amount = resolveRowAmount(tx?.paidAmount ?? null, priceMap.get(sub.billing_cycle))

  const histRows = (history ?? []) as unknown as {
    id: string
    subscription_id: string
    plan_name_snapshot: string | null
    billing_cycle: string | null
    amount: number | null
    status: string | null
    period_start: string | null
    period_end: string | null
    source: string
    admin_action_id: string | null
    created_at: string
  }[]
  // Rows arrive newest-first; the newest row belonging to THIS
  // subscription is the one highlighted as "current" on the page.
  const currentHistoryId = histRows.find((h) => h.subscription_id === subscriptionId)?.id ?? null
  const rows: VaultHistoryRow[] = histRows.map((h) => ({
    id: h.id,
    planName: h.plan_name_snapshot,
    billingCycle: h.billing_cycle,
    started: h.period_start,
    ends: h.period_end,
    amount: h.amount == null ? null : Number(h.amount),
    status: h.status,
    source: h.source,
    reference: h.admin_action_id,
    createdAt: h.created_at,
    isCurrent: h.id === currentHistoryId,
  }))

  const prof = (profile ?? {}) as {
    full_name?: string
    email?: string
    phone?: string | null
    created_at?: string
    updated_at?: string
  }
  const cancelledOn =
    sub.status === 'canceled'
      ? (histRows.find((h) => h.status === 'canceled')?.created_at ?? null)
      : null

  const paid = rows.filter((r) => (r.amount ?? 0) > 0).length

  return {
    subscription: {
      subscriptionId: sub.id,
      accountId: sub.account_id,
      userId: sub.user_id,
      customer: {
        name: prof.full_name ?? '—',
        email: prof.email ?? '—',
        phone: prof.phone ?? null,
        registeredAt: prof.created_at ?? null,
      },
      planId: sub.plan_id,
      planName: planNameOf(sub),
      subscribedOn: sub.created_at,
      expiresOn: sub.current_period_end ?? sub.trial_end ?? null,
      amount,
      billingCycle: sub.billing_cycle,
      status: computeVaultStatus(sub, now),
      paymentState: tx?.latest ?? null,
      gatewayLinked: Boolean(sub.gateway_subscription_id),
      updatedAt: sub.updated_at,
      periodStart: sub.current_period_start,
      trialEnd: sub.trial_end,
      trialClaimedAt: sub.trial_claimed_at,
      gateway: sub.gateway,
      gatewaySubscriptionId: sub.gateway_subscription_id,
      gatewayCustomerId: sub.gateway_customer_id,
      cancelledOn,
    },
    plan: {
      name: planNameOf(sub),
      prices: { monthly: priceMap.get('monthly') ?? null, yearly: priceMap.get('yearly') ?? null },
      limits: Object.entries(entitlements.limits).map(([feature, value]) => ({
        feature,
        value: value ?? 0,
        period:
          (entitlements.limitPeriods as Record<string, string | undefined>)[feature] ?? 'total',
      })),
      features: Object.entries(entitlements.features).map(([feature, enabled]) => ({
        feature,
        enabled: Boolean(enabled),
      })),
    },
    usage: entitlements.usage as Record<string, number>,
    customer: {
      userId: sub.user_id,
      name: prof.full_name ?? '—',
      email: prof.email ?? '—',
      phone: prof.phone ?? null,
      accountName: ((account ?? {}) as { name?: string }).name ?? null,
      registeredAt: prof.created_at ?? null,
      lastActiveAt: prof.updated_at ?? null,
    },
    history: {
      rows,
      total: rows.length,
      paid,
      trialOrOther: rows.length - paid,
    },
  }
}

/* ------------------------------------------------------------------ *
 * PATCH update — schema validation (mirrors the RPC's last-line
 * checks) + the single-transaction admin_update_subscription call.
 * ------------------------------------------------------------------ */

export interface VaultUpdateInput {
  planId: string
  billingCycle: 'monthly' | 'yearly'
  /** Display vocabulary; mapped to the stored enum below. */
  status: 'active' | 'cancelled' | 'expired'
  /** UTC instant of the chosen expiry day's end (computed by the
   *  route from the date input via dayEndExclusiveUtcMs). */
  periodEnd: string
  amount: number
  reason: string
  expectedUpdatedAt: string
}

export type VaultUpdateValidation =
  | { ok: true; value: VaultUpdateInput }
  | { ok: false; fieldErrors: Record<string, string> }

const STORED_STATUS: Record<VaultUpdateInput['status'], 'active' | 'canceled' | 'expired'> = {
  active: 'active',
  cancelled: 'canceled',
  expired: 'expired',
}

/** Hand-rolled schema check (repo ships no zod) — everything the spec
 *  lists in Part 4.5, with per-field messages for the panel. */
export function validateVaultUpdate(body: unknown): VaultUpdateValidation {
  const errors: Record<string, string> = {}
  const b = (body ?? {}) as Record<string, unknown>

  const planId = typeof b.planId === 'string' ? b.planId.trim() : ''
  if (!planId) errors.planId = 'Choose a plan.'

  const billingCycle = b.billingCycle
  if (billingCycle !== 'monthly' && billingCycle !== 'yearly') errors.billingCycle = 'Monthly or yearly.'

  const status = b.status
  if (status !== 'active' && status !== 'cancelled' && status !== 'expired') {
    errors.status = 'Active, Cancelled or Expired.'
  }

  const periodEnd = typeof b.periodEnd === 'string' && !Number.isNaN(Date.parse(b.periodEnd)) ? b.periodEnd : ''
  if (!periodEnd) errors.periodEnd = 'Pick an expiry date.'
  else if (status === 'active' && Date.parse(periodEnd) <= Date.now()) {
    errors.periodEnd = 'An Active subscription needs a future expiry date.'
  }

  const amount = typeof b.amount === 'number' ? b.amount : Number(b.amount)
  if (!Number.isFinite(amount) || amount < 0) errors.amount = 'Amount must be 0 or more.'
  else if (Math.round(amount * 100) / 100 !== amount) errors.amount = 'Amount allows two decimals.'
  else if (amount > 9_99_99_999.99) errors.amount = 'Amount exceeds the billing schema.'

  const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
  if (reason.length < 5) errors.reason = 'A reason of at least 5 characters is required.'
  else if (reason.length > 500) errors.reason = 'Reason is too long (max 500).'

  const expectedUpdatedAt = typeof b.expectedUpdatedAt === 'string' ? b.expectedUpdatedAt : ''
  if (!expectedUpdatedAt || Number.isNaN(Date.parse(expectedUpdatedAt))) {
    errors.expectedUpdatedAt = 'Missing concurrency token — reload the row.'
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors }
  return {
    ok: true,
    value: {
      planId,
      billingCycle: billingCycle as VaultUpdateInput['billingCycle'],
      status: status as VaultUpdateInput['status'],
      periodEnd: new Date(periodEnd).toISOString(),
      amount: Math.round(amount * 100) / 100,
      reason,
      expectedUpdatedAt,
    },
  }
}

export type VaultUpdateResult =
  | { kind: 'ok'; row: VaultRowDto & { updatedAt: string } }
  | { kind: 'conflict'; message: string }
  | { kind: 'notFound' }
  | { kind: 'rpcError'; error: string }
  | { kind: 'schemaMissing' }
  | { kind: 'failed'; message: string }

interface RpcRow {
  id: string
  account_id: string
  user_id: string
  plan_id: string
  status: string
  billing_cycle: string
  current_period_end: string | null
  trial_end: string | null
  updated_at: string
  plan_name?: string
}

function rpcRowToDto(r: RpcRow): VaultRowDto & { updatedAt: string } {
  return {
    subscriptionId: r.id,
    accountId: r.account_id,
    userId: r.user_id,
    customer: { name: '', email: '', phone: null, registeredAt: null },
    planId: r.plan_id,
    planName: r.plan_name ?? r.plan_id,
    subscribedOn: '',
    expiresOn: r.current_period_end ?? r.trial_end ?? null,
    amount: 0,
    billingCycle: r.billing_cycle,
    status: computeVaultStatus(r),
    paymentState: null,
    gatewayLinked: false,
    updatedAt: r.updated_at,
  }
}

export async function applyVaultUpdate(
  ownerUserId: string,
  subscriptionId: string,
  input: VaultUpdateInput,
  ip: string | null,
): Promise<VaultUpdateResult> {
  const { data, error } = await supabaseAdmin().rpc('admin_update_subscription', {
    p_subscription_id: subscriptionId,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_plan_id: input.planId,
    p_billing_cycle: input.billingCycle,
    p_status: STORED_STATUS[input.status],
    p_period_end: input.periodEnd,
    p_amount: input.amount,
    p_reason: input.reason,
    p_admin_user_id: ownerUserId,
    p_ip: ip,
  })

  if (error) {
    if (isMissingSchema(error)) return { kind: 'schemaMissing' }
    console.error('[admin-vault] update rpc failed:', error.message)
    return { kind: 'failed', message: 'update_failed' }
  }

  const res = (data ?? {}) as {
    ok?: boolean
    error?: string
    row?: RpcRow
    account_id?: string
  }
  if (res.ok && res.row) {
    // Take effect for the customer immediately — drop the 15 s plan
    // cache so limits change without re-login (spec 4.5).
    if (res.account_id) invalidateEntitlements(res.account_id)
    return { kind: 'ok', row: rpcRowToDto(res.row) }
  }
  if (res.error === 'stale') return { kind: 'conflict', message: 'subscription_changed' }
  if (res.error === 'not_found') return { kind: 'notFound' }
  return { kind: 'rpcError', error: res.error ?? 'invalid' }
}
