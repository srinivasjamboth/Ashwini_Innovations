/**
 * Metric definitions for the Super Admin Dashboard — the ONE shared
 * server module. Every card, chart point, and table row on Pulse /
 * Member Ledger / Plan Vault is computed here, so the definitions in
 * the spec (section 3) cannot drift between pages.
 *
 * "User" here always means a registered CUSTOMER:
 *   profiles.account_role = 'owner' — the trigger at signup gives
 *   every new account an owner-role profile, while teammates who
 *   redeem an invitation are moved to admin/agent/viewer, so they are
 *   excluded automatically. The Platform Owner's own account
 *   (ADMIN_OWNER_USER_ID) is excluded from every count and list.
 *   There are no soft-deleted records in this schema (no deleted_at
 *   columns anywhere), so that clause is a no-op — noted in the
 *   report rather than guessed at.
 *
 * All queries run with the service-role key on the server and in
 * parallel; the browser never sees raw tables, only these bundles.
 */

import { supabaseAdmin } from './supabase-admin'
import { getLastSuccessfulLogin } from './audit'
import { computeEffectiveStatus } from '@/lib/plans/entitlements'
import {
  ACTIVE_WINDOW_DAYS,
  ADMIN_TIMEZONE,
  CHART_MONTHS,
  FRESH_USERS_LIMIT,
  LEDGER_PAGE_SIZE,
} from './constants'

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

export type SubscriptionType = 'Free' | 'Monthly' | 'Yearly'

export interface MonthPoint {
  /** First day of the month in the admin timezone, ISO date. */
  month_start: string
  new_users: number
  cumulative: number
}

export interface FreshUser {
  userId: string
  fullName: string
  email: string
  phone: string | null
  registeredAt: string
  subscriptionType: SubscriptionType
}

export interface PulseBundle {
  totalUsers: number
  activeUsers: number
  totalCampaigns: number
  contacts: number
  subscribers: number
  freeUsers: number
  months: MonthPoint[]
  freshUsers: FreshUser[]
  lastLoginAt: string | null
  /** False when the schema has no subscriptions/plans yet — the UI
   *  still renders Monthly/Yearly affordances, they simply show zero. */
  subscriptionsAvailable: boolean
}

export interface MemberRow extends FreshUser {
  subscriptionStatus: string | null
  planName: string | null
  renewsOrExpiresAt: string | null
}

export interface MemberPage {
  rows: MemberRow[]
  total: number
  page: number
  pageSize: number
  subscriptionsAvailable: boolean
}

// ------------------------------------------------------------
// Subscription lookup (forward-compatible)
//
// This schema has NO subscriptions/plans tables yet (verified against
// every migration). Per the spec the code supports them anyway: the
// moment an operator adds `plans` + `subscriptions` with the columns
// referenced below, the Monthly/Yearly splits come alive with no
// dashboard changes. Every helper degrades to "no paid subscriptions"
// when the tables are missing (Postgres code 42P01 / PostgREST 404).
// ------------------------------------------------------------

interface SubscriptionInfo {
  type: SubscriptionType
  status: string | null
  planName: string | null
  renewsOrExpiresAt: string | null
}

const FREE: SubscriptionInfo = {
  type: 'Free',
  status: null,
  planName: null,
  renewsOrExpiresAt: null,
}

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  return (
    err.code === '42P01' ||
    err.code === 'PGRST205' ||
    /does not exist|not found/i.test(err.message ?? '')
  )
}

function cycleToType(cycle: unknown, price: unknown): SubscriptionType | null {
  const paid = Number(price ?? 0) > 0
  if (!paid) return null
  const c = String(cycle ?? '').toLowerCase()
  if (c.startsWith('year') || c === 'annual') return 'Yearly'
  if (c.startsWith('month')) return 'Monthly'
  return 'Monthly' // an unlabelled paid cycle is treated as monthly
}

/** Active-paid subscription info for a set of users. Missing schema ⇒
 *  empty map (everyone Free) with the availability flag turned off.
 *
 *  Part 3.2 rewiring: the paid/expired decision uses the SAME shared
 *  `computeEffectiveStatus` the enforcement engine and Plan Vault use
 *  — a stored `active` row whose period end has passed (plus the
 *  grace window) counts as expired here too, so Pulse, the Ledger,
 *  the Vault and the customer's own banner can never disagree. */
async function lookupSubscriptions(
  userIds: string[],
): Promise<{ map: Map<string, SubscriptionInfo>; available: boolean }> {
  const map = new Map<string, SubscriptionInfo>()
  if (userIds.length === 0) return { map, available: true }
  try {
    const { data, error } = await supabaseAdmin()
      .from('subscriptions')
      .select('user_id,status,current_period_end,trial_end,billing_cycle,plans(name,price,interval)')
      .in('user_id', userIds)
      .in('status', ['trialing', 'active', 'past_due'])
    if (isMissingTable(error)) return { map, available: false }
    if (error) {
      console.error('[admin-metrics] subscription lookup failed:', error)
      return { map, available: false }
    }
    for (const row of data ?? []) {
      const plan = (row as Record<string, unknown>).plans as
        | { name?: string; price?: number; interval?: string }
        | undefined
      const type = cycleToType(row.billing_cycle ?? plan?.interval, plan?.price)
      if (!type) continue
      const eff = computeEffectiveStatus({
        status: row.status as never,
        current_period_end: row.current_period_end as string | null,
        trial_end: (row as Record<string, unknown>).trial_end as string | null,
      })
      if (eff === 'expired') continue
      map.set(row.user_id as string, {
        type,
        // Effective, not stored — the ledger displays what the engine
        // actually enforces.
        status: eff,
        planName: plan?.name ?? null,
        renewsOrExpiresAt: (row.current_period_end as string) ?? null,
      })
    }
    return { map, available: true }
  } catch (err) {
    console.error('[admin-metrics] subscription lookup threw:', err)
    return { map, available: false }
  }
}

// ------------------------------------------------------------
// Shared primitives
// ------------------------------------------------------------

/** The owner's own account id — used to drop their campaigns/contacts
 *  from cross-tenant aggregates (spec: exclude my account everywhere). */
async function getOwnerAccountId(ownerUserId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('accounts')
    .select('id')
    .eq('owner_user_id', ownerUserId)
    .maybeSingle()
  return data?.id ?? null
}

async function countCustomers(ownerUserId: string): Promise<number> {
  const { count, error } = await supabaseAdmin()
    .from('profiles')
    .select('user_id', { count: 'exact', head: true })
    .eq('account_role', 'owner')
    .neq('user_id', ownerUserId)
  if (error) throw error
  return count ?? 0
}

/**
 * Whether the hosted `profiles` table has the `phone` column (added in
 * migration 044, but not applied on every project). Reading a missing
 * column errors the whole query (42703) and takes down the bundle, so
 * every customer-list read is gated on this one probe. Cached per
 * process — a single extra round-trip the first time, none after.
 */
let phoneColumnCache: boolean | null = null
async function profilesHasPhone(): Promise<boolean> {
  if (phoneColumnCache !== null) return phoneColumnCache
  const { error } = await supabaseAdmin().from('profiles').select('phone').limit(1)
  if (error && !isMissingColumnError(error)) {
    console.error('[admin-metrics] phone-column probe failed:', error)
  }
  phoneColumnCache = !error
  return phoneColumnCache
}

function isMissingColumnError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  return err.code === '42703' || /column .* does not exist/i.test(err.message ?? '')
}

// ------------------------------------------------------------
// Base-table replacements for the admin RPCs
//
// The dashboard was written against three SECURITY DEFINER functions
// (admin_active_user_count / admin_new_users_by_month /
// admin_recent_customers, migration 045). They are not installed on
// every hosted project, and when missing each call 500s the whole
// Pulse bundle (PostgREST PGRST202). These helpers reproduce the exact
// same semantics straight from `profiles`, so the dashboard renders
// with or without the functions. The only signal we can't reach is
// auth.users.last_sign_in_at (PostgREST never exposes the auth
// schema) — the RPC folded it into GREATEST(...) alongside the profile
// timestamps we DO have, so `updated_at OR created_at >= threshold`
// keeps the active-user definition faithful.
// ------------------------------------------------------------

/** 'YYYY-MM' bucket key for an instant, cut in the admin timezone. */
function monthKeyInTz(instant: Date, tz: string): string {
  // en-CA formats ISO-style YYYY-MM-DD; take the YYYY-MM prefix.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
  })
    .format(instant)
    .slice(0, 7)
}

/** Trailing `count` month buckets (oldest→newest), ending in the
 *  current month in `tz`, each with its ISO 'YYYY-MM-01' start. */
function buildMonthSeries(
  count: number,
  tz: string,
): { key: string; month_start: string }[] {
  const cur = monthKeyInTz(new Date(), tz)
  const y = Number(cur.slice(0, 4))
  const m = Number(cur.slice(5, 7))
  const out: { key: string; month_start: string }[] = []
  for (let back = count - 1; back >= 0; back--) {
    let yy = y
    let mm = m - back
    while (mm <= 0) {
      mm += 12
      yy -= 1
    }
    const key = `${yy}-${String(mm).padStart(2, '0')}`
    out.push({ key, month_start: `${key}-01` })
  }
  return out
}

/** admin_new_users_by_month, computed from profiles. Zero-filled. */
async function computeNewUsersByMonth(ownerUserId: string): Promise<MonthPoint[]> {
  const { data, error } = await supabaseAdmin()
    .from('profiles')
    .select('created_at')
    .eq('account_role', 'owner')
    .neq('user_id', ownerUserId)
  if (error) throw error

  const counts = new Map<string, number>()
  for (const row of (data ?? []) as { created_at: string | null }[]) {
    if (!row.created_at) continue
    const key = monthKeyInTz(new Date(row.created_at), ADMIN_TIMEZONE)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  let running = 0
  return buildMonthSeries(CHART_MONTHS, ADMIN_TIMEZONE).map((s) => {
    const new_users = counts.get(s.key) ?? 0
    running += new_users
    return { month_start: s.month_start, new_users, cumulative: running }
  })
}

/** admin_active_user_count, computed from profiles. */
async function computeActiveUserCount(ownerUserId: string): Promise<number> {
  const threshold = new Date(
    Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const { count, error } = await supabaseAdmin()
    .from('profiles')
    .select('user_id', { count: 'exact', head: true })
    .eq('account_role', 'owner')
    .neq('user_id', ownerUserId)
    .or(`updated_at.gte.${threshold},created_at.gte.${threshold}`)
  if (error) throw error
  return count ?? 0
}

/** admin_recent_customers, computed from profiles (newest first). */
async function computeRecentCustomers(
  ownerUserId: string,
  limit: number,
): Promise<
  {
    user_id: string
    full_name: string
    email: string
    phone: string | null
    registered_at: string
  }[]
> {
  const hasPhone = await profilesHasPhone()
  const { data, error } = await supabaseAdmin()
    .from('profiles')
    .select(
      hasPhone
        ? 'user_id,full_name,email,phone,created_at'
        : 'user_id,full_name,email,created_at',
    )
    .eq('account_role', 'owner')
    .neq('user_id', ownerUserId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200))
  if (error) throw error
  return ((data ?? []) as unknown as {
    user_id: string
    full_name: string
    email: string
    phone?: string | null
    created_at: string
  }[]).map((x) => ({
    user_id: x.user_id,
    full_name: x.full_name,
    email: x.email,
    phone: x.phone ?? null,
    registered_at: x.created_at,
  }))
}

// ------------------------------------------------------------
// Pulse
// ------------------------------------------------------------

export async function getPulseBundle(ownerUserId: string): Promise<PulseBundle> {
  const db = supabaseAdmin()

  // Independent queries fire in parallel (spec §7).
  const ownerAccountP = getOwnerAccountId(ownerUserId)
  const totalP = countCustomers(ownerUserId)
  const activeP = computeActiveUserCount(ownerUserId)
  const campaignsP = ownerAccountP.then(async (accountId) => {
    let q = db.from('broadcasts').select('id', { count: 'exact', head: true })
    if (accountId) q = q.neq('account_id', accountId)
    const { count, error } = await q
    if (error) throw error
    return count ?? 0
  })
  const contactsP = ownerAccountP.then(async (accountId) => {
    let q = db.from('contacts').select('id', { count: 'exact', head: true })
    if (accountId) q = q.neq('account_id', accountId)
    const { count, error } = await q
    if (error) throw error
    return count ?? 0
  })
  const monthsP = computeNewUsersByMonth(ownerUserId)
  const freshP = computeRecentCustomers(ownerUserId, FRESH_USERS_LIMIT).then(
    async (rows) => {
      const { map, available } = await lookupSubscriptions(rows.map((x) => x.user_id))
      const users: FreshUser[] = rows.map((x) => ({
        userId: x.user_id,
        fullName: x.full_name,
        email: x.email,
        phone: x.phone,
        registeredAt: x.registered_at,
        subscriptionType: map.get(x.user_id)?.type ?? 'Free',
      }))
      return { users, available }
    },
  )
  const lastLoginP = getLastSuccessfulLogin()

  const [total, active, campaigns, contacts, months, fresh, lastLoginAt] = await Promise.all([
    totalP,
    activeP,
    campaignsP,
    contactsP,
    monthsP,
    freshP,
    lastLoginP,
  ])

  // Subscribers: customers whose lookup produced a paid subscription
  // (status active AND plan price > 0 — enforced inside
  // lookupSubscriptions/cycleToType). Full-table count when the schema
  // exists is the same filter over every customer, so we count from the
  // ledger-wide lookup rather than the 10-row page:
  const { subscriberCount, available } = fresh.available
    ? await activePaidSubscriberCount(ownerUserId)
    : { subscriberCount: 0, available: false }

  return {
    totalUsers: total,
    activeUsers: active,
    totalCampaigns: campaigns,
    contacts,
    subscribers: subscriberCount,
    // Guarantees Free + Subscribers = Total by construction.
    freeUsers: total - subscriberCount,
    months,
    freshUsers: fresh.users,
    lastLoginAt,
    subscriptionsAvailable: available,
  }
}

/** Count of customers with an EFFECTIVELY active paid subscription
 *  (shared computeEffectiveStatus says active/trialing AND plan price
 *  > 0). Pre-rewiring this counted stored `status = 'active'` rows
 *  only, so lapsed periods counted as subscribers until the cron
 *  caught up — Part 3.2 makes Subscribers + Free agree with the
 *  Vault, per spec “report any Pulse numbers that change”. */
async function activePaidSubscriberCount(
  ownerUserId: string,
): Promise<{ subscriberCount: number; available: boolean }> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('subscriptions')
      .select('user_id,status,current_period_end,trial_end,plans(price,interval)')
      .in('status', ['trialing', 'active', 'past_due'])
      .neq('user_id', ownerUserId)
    if (isMissingTable(error)) return { subscriberCount: 0, available: false }
    if (error) {
      console.error('[admin-metrics] subscriber count failed:', error)
      return { subscriberCount: 0, available: false }
    }
    let n = 0
    for (const raw of data ?? []) {
      const row = raw as Record<string, unknown>
      const plan = row.plans as { price?: number; interval?: string } | undefined
      if (cycleToType(row.billing_cycle ?? plan?.interval, plan?.price) === null) continue
      const eff = computeEffectiveStatus({
        status: row.status as never,
        current_period_end: (row.current_period_end as string) ?? null,
        trial_end: (row.trial_end as string) ?? null,
      })
      if (eff !== 'expired') n += 1
    }
    return { subscriberCount: n, available: true }
  } catch {
    return { subscriberCount: 0, available: false }
  }
}

// ------------------------------------------------------------
// Member Ledger
// ------------------------------------------------------------

export interface MemberQuery {
  page?: number
  q?: string
  sort?: 'newest' | 'oldest'
  /** Subscription-type / plan / status filters. With no billing schema
   *  present only 'Free' can ever match; the parameters still shape the
   *  URL contract so saved views survive the day subscriptions land. */
  subscription?: 'free' | 'monthly' | 'yearly'
  plan?: string
  status?: string
}

export async function getMemberPage(
  ownerUserId: string,
  query: MemberQuery,
): Promise<MemberPage> {
  const page = Math.max(1, Math.floor(query.page ?? 1))
  const pageSize = LEDGER_PAGE_SIZE
  const hasPhone = await profilesHasPhone()

  let q = supabaseAdmin()
    .from('profiles')
    .select(
      hasPhone
        ? 'user_id,full_name,email,phone,created_at'
        : 'user_id,full_name,email,created_at',
      { count: 'exact' },
    )
    .eq('account_role', 'owner')
    .neq('user_id', ownerUserId)

  const needle = query.q?.trim()
  if (needle && needle.length >= 2) {
    // Names/emails may contain commas — escape them so the PostgREST
    // `or` list can't be broken out of. Phone is only searched when the
    // column exists on this project.
    const safe = needle.replace(/,/g, '\\,')
    const clauses = [`full_name.ilike.%${safe}%`, `email.ilike.%${safe}%`]
    if (hasPhone) clauses.push(`phone.ilike.%${safe}%`)
    q = q.or(clauses.join(','))
  }

  const order = query.sort === 'oldest' ? { ascending: true } : { ascending: false }
  q = q.order('created_at', order).range((page - 1) * pageSize, page * pageSize - 1)

  const { data, count, error } = await q
  if (error) throw error

  const rows0 = (data ?? []) as unknown as {
    user_id: string
    full_name: string
    email: string
    phone?: string | null
    created_at: string
  }[]
  const { map, available } = await lookupSubscriptions(rows0.map((x) => x.user_id))

  let rows: MemberRow[] = rows0.map((x) => {
    const sub = map.get(x.user_id) ?? FREE
    return {
      userId: x.user_id,
      fullName: x.full_name,
      email: x.email,
      phone: x.phone ?? null,
      registeredAt: x.created_at,
      subscriptionType: sub.type,
      subscriptionStatus: sub.status,
      planName: sub.planName,
      renewsOrExpiresAt: sub.renewsOrExpiresAt,
    }
  })

  // Client-side filter application only matters once the billing
  // schema exists; with everything Free it's a pass-through otherwise.
  if (query.subscription && available) {
    const want =
      query.subscription === 'free' ? 'Free' : query.subscription === 'monthly' ? 'Monthly' : 'Yearly'
    rows = rows.filter((r) => r.subscriptionType === want)
  }
  if (query.plan && available) {
    rows = rows.filter((r) => r.planName === query.plan)
  }
  if (query.status && available) {
    rows = rows.filter((r) => r.subscriptionStatus === query.status)
  }

  return { rows, total: count ?? 0, page, pageSize, subscriptionsAvailable: available }
}

// ------------------------------------------------------------
// Plan Vault
// ------------------------------------------------------------

export interface AdminPlan {
  id: string
  name: string
  price: number | null
  billingCycle: string | null
  limits: Record<string, unknown> | null
  features: Record<string, boolean> | null
  active: boolean
  monthlySubscribers: number
  yearlySubscribers: number
}

export interface PlansBundle {
  plans: AdminPlan[]
  available: boolean
  freeUsers: number
  totalUsers: number
}

/** Normalizer for a `plans` row. The table doesn't exist in this
 *  schema yet, so column names are best-effort across the common
 *  shapes — one function to adjust when the real tables land. */
function normalizePlan(row: Record<string, unknown>): AdminPlan {
  const name = (row.name ?? row.title ?? 'Unnamed plan') as string
  const price = (row.price ?? row.price_monthly ?? row.amount ?? null) as number | null
  const cycle = (row.billing_cycle ?? row.interval ?? row.period ?? null) as string | null
  const status = (row.status ?? row.active ?? null) as unknown
  return {
    id: String(row.id ?? name),
    name,
    price,
    billingCycle: cycle,
    limits: (row.limits ?? row.features_limits ?? null) as Record<string, unknown> | null,
    features: (row.feature_flags ?? row.features ?? null) as Record<string, boolean> | null,
    active: !(status === false || status === 'inactive'),
    monthlySubscribers: 0,
    yearlySubscribers: 0,
  }
}

export async function getPlans(ownerUserId: string): Promise<PlansBundle> {
  const total = await countCustomers(ownerUserId)

  let plans: AdminPlan[] = []
  let available = true
  try {
    const { data, error } = await supabaseAdmin().from('plans').select('*')
    if (isMissingTable(error)) {
      available = false
    } else if (error) {
      console.error('[admin-metrics] plans read failed:', error)
      available = false
    } else {
      plans = ((data ?? []) as Record<string, unknown>[]).map(normalizePlan)
    }
  } catch {
    available = false
  }

  // Subscriber splits per plan, only meaningful once subscriptions
  // exist; counts come straight from the DB, not the browser — and
  // through the shared effective-status function (Part 3.2), so a
  // plan's Monthly/Yearly counts match the Vault rows for it.
  if (available) {
    try {
      const { data, error } = await supabaseAdmin()
        .from('subscriptions')
        .select('plan_id,status,billing_cycle,current_period_end,trial_end,plans(interval)')
        .in('status', ['trialing', 'active', 'past_due'])
        .neq('user_id', ownerUserId)
      if (!error && data) {
        for (const row of data as Record<string, unknown>[]) {
          const eff = computeEffectiveStatus({
            status: row.status as never,
            current_period_end: (row.current_period_end as string) ?? null,
            trial_end: (row.trial_end as string) ?? null,
          })
          if (eff === 'expired') continue
          const plan = plans.find((p) => p.id === String(row.plan_id))
          if (!plan) continue
          const type = cycleToType(row.billing_cycle ?? (row.plans as { interval?: string } | undefined)?.interval, plan.price ?? 1)
          if (type === 'Yearly') plan.yearlySubscribers += 1
          else if (type === 'Monthly') plan.monthlySubscribers += 1
        }
      }
    } catch (err) {
      console.error('[admin-metrics] subscriber split failed:', err)
    }
  }

  return { plans, available, freeUsers: total, totalUsers: total }
}
