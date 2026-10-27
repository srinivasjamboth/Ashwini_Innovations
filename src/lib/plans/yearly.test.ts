import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  addCalendarMonths,
  advancePeriod,
  currentWindowAnchor,
  cycleStepMonths,
  quotaWindowForPeriod,
  windowMonthKey,
} from './period';
import { cardLimits, cardLimitPeriods, getPlanCatalog, type PlanCard } from './catalog';
import {
  __resetPlanCacheForTests,
  checkLimit,
  getEntitlements,
  incrementUsage,
} from './entitlements';
import { evaluateOfferingChange, settlePreviousGatewaySubscription } from './billing';
import { LIMIT_FEATURES, type LimitFeature } from './config';

// ============================================================
// YEARLY BILLING (spec PART 2/3/4/5/7) — what is testable without a
// live database or a gateway:
//
//   · 12-month period math: anniversary windows + leap-day clamping,
//   · the STORED yearly overlay every surface reads (nothing ×12 at
//     runtime) and its per-figure monthly fallback,
//   · the yearly bulk pool: ONE window per subscription period — no
//     monthly reset, no rollover, no cross-talking with a monthly
//     counter that happens to share the same date key,
//   · the catalog's data-driven yearly gate (no broken checkout),
//   · the yearly downgrade / switch rule,
//   · the double-billing guard: the previous gateway subscription is
//     cancelled once, never on top of itself, and a gateway failure
//     never blocks a paid activation.
//
// Reads go through a hand-rolled PostgREST-shaped fake (chainable and
// thenable — exactly the shape the services use), so these assertions
// are about OUR logic, not about Supabase.
// ============================================================

const iso = (d: Date) => d.toISOString();
const at = (y: number, m: number, day: number, h = 0) => new Date(Date.UTC(y, m - 1, day, h));

/* ------------------------------------------------------------------ *
 * Fake PostgREST client
 * ------------------------------------------------------------------ */
type Row = Record<string, unknown>;
interface Filter {
  op: 'eq' | 'neq' | 'gt' | 'is' | 'in';
  col: string;
  val: unknown;
}
interface Fake {
  client: SupabaseClient;
  reads: string[];
  writes: { table: string; method: string; record: Row; filters: Filter[] }[];
  tables: Record<string, Row[]>;
}

function fakeDb(opts: {
  tables: Record<string, Row[]>;
  /** Tables that answer as if the relation does not exist yet. */
  missing?: string[];
}): Fake {
  const reads: string[] = [];
  const writes: Fake['writes'] = [];

  const from = (table: string) => {
    const filters: Filter[] = [];
    let head = false;
    let single = false;

    const matchOne = (r: Row, f: Filter): boolean => {
      const v = r[f.col];
      switch (f.op) {
        case 'eq':
          return String(v) === String(f.val);
        case 'neq':
          return String(v) !== String(f.val);
        case 'is':
          return v === f.val || (v === undefined && f.val === null);
        case 'gt':
          return new Date(v as string).getTime() > new Date(f.val as string).getTime();
        case 'in':
          return (f.val as unknown[]).some((x) => String(x) === String(v));
      }
    };
    const respond = (): unknown => {
      if (opts.missing?.includes(table)) {
        return {
          data: null,
          count: null,
          error: { code: '42P01', message: `relation "${table}" does not exist` },
        };
      }
      const rows = (opts.tables[table] ?? []).filter((r) => filters.every((f) => matchOne(r, f)));
      if (head) return { data: null, count: rows.length, error: null };
      if (single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };

    const b: Record<string, unknown> = {};
    const push = (op: Filter['op']) => (col: string, val: unknown) => {
      filters.push({ op, col, val });
      return b;
    };
    b.select = (cols: string, o?: { head?: boolean }) => {
      head = Boolean(o?.head);
      reads.push(`${table}:${cols}`);
      return b;
    };
    b.eq = push('eq');
    b.neq = push('neq');
    b.gt = push('gt');
    b.is = push('is');
    b.in = (col: string, vals: unknown[]) => {
      filters.push({ op: 'in', col, val: vals });
      return b;
    };
    // Ordering / paging never change which rows the fixtures hold.
    b.order = () => b;
    b.limit = () => b;
    b.range = () => b;
    b.maybeSingle = () => {
      single = true;
      return b;
    };
    b.single = () => {
      single = true;
      return b;
    };
    b.insert = (record: Row) => {
      // filters is kept by reference: the write is scoped by the .eq() calls
      // that come AFTER insert()/update() in the chain.
      writes.push({ table, method: 'insert', record, filters });
      return b;
    };
    b.update = (record: Row) => {
      writes.push({ table, method: 'update', record, filters });
      return b;
    };
    // Awaitable, so `await q` and `await q.maybeSingle()` both work.
    b.then = (resolve: (v: unknown) => void) => resolve(respond());
    return b;
  };

  const client = { from } as unknown as SupabaseClient;
  return { client, reads, writes, tables: opts.tables };
}

/** billing.ts / catalog.ts build their own service-role client internally,
 *  so the module is mocked once and pointed at whichever fake a test needs.
 *  (Entitlement tests pass `admin` explicitly instead.) */
let active = fakeDb({ tables: {} });
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => active.client,
}));

/* ------------------------------------------------------------------ *
 * Fixtures shaped like the 048 + 052 seed
 * ------------------------------------------------------------------ */
const MONTHLY_LIMITS: Row[] = [
  { plan_id: 'starter', feature: 'contacts', value: 1000, period: 'total' },
  { plan_id: 'starter', feature: 'bulk_messages', value: 5000, period: 'monthly' },
  { plan_id: 'starter', feature: 'templates', value: 10, period: 'total' },
  { plan_id: 'starter', feature: 'quick_replies', value: 20, period: 'total' },
  { plan_id: 'starter', feature: 'automation_flows', value: 3, period: 'total' },
  { plan_id: 'starter', feature: 'whatsapp_forms', value: 3, period: 'total' },
  // deliberately NO yearly row for team_members → per-figure fallback
  { plan_id: 'starter', feature: 'team_members', value: 2, period: 'total' },
];
const YEARLY_LIMITS: Row[] = [
  { plan_id: 'starter', feature: 'contacts', value: 12000, period: 'total' },
  { plan_id: 'starter', feature: 'bulk_messages', value: 60000, period: 'yearly' },
  { plan_id: 'starter', feature: 'templates', value: 120, period: 'total' },
  { plan_id: 'starter', feature: 'quick_replies', value: 240, period: 'total' },
  { plan_id: 'starter', feature: 'automation_flows', value: 36, period: 'total' },
  { plan_id: 'starter', feature: 'whatsapp_forms', value: 36, period: 'total' },
];
const UNLIMITED_ROWS: Row[] = LIMIT_FEATURES.map((feature: LimitFeature) => ({
  plan_id: 'enterprise',
  feature,
  value: -1,
  period: feature === 'bulk_messages' ? 'yearly' : 'total',
}));

function subRow(over: Row = {}): Row {
  return {
    account_id: 'acct-1',
    user_id: 'user-1',
    plan_id: 'starter',
    status: 'active',
    billing_cycle: 'monthly',
    current_period_start: iso(at(2026, 1, 15)),
    current_period_end: iso(at(2026, 2, 15)),
    trial_end: null,
    trial_claimed_at: null,
    ...over,
  };
}

function yearlySub(over: Row = {}): Row {
  return subRow({
    billing_cycle: 'yearly',
    current_period_end: iso(at(2027, 1, 15)),
    ...over,
  });
}

function entitlementTables(over: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    subscriptions: [subRow()],
    plans: [{ id: 'starter', name: 'Starter' }],
    plan_limits: MONTHLY_LIMITS,
    plan_yearly_limits: YEARLY_LIMITS,
    plan_features: [
      { plan_id: 'starter', feature: 'fields_tags', enabled: true },
      { plan_id: 'starter', feature: 'broadcast_scheduler', enabled: false },
    ],
    contacts: [],
    message_templates: [],
    quick_replies: [],
    automations: [],
    whatsapp_flows: [],
    profiles: [],
    account_invitations: [],
    usage_counters: [],
    ...over,
  };
}

const manyContacts = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, account_id: 'acct-1' }));

/* ------------------------------------------------------------------ *
 * PART 2/5 — period math for a 12-month cycle
 * ------------------------------------------------------------------ */
describe('yearly period math', () => {
  it('a cycle step is 1 month monthly, 12 months yearly', () => {
    expect(cycleStepMonths('monthly')).toBe(1);
    expect(cycleStepMonths('yearly')).toBe(12);
  });

  it('a yearly period end is exactly one calendar year after the start', () => {
    expect(iso(advancePeriod(at(2026, 1, 15), 'yearly'))).toBe(iso(at(2027, 1, 15)));
  });

  it('clamps a 29 Feb start to 28 Feb in a non-leap year', () => {
    expect(iso(advancePeriod(at(2024, 2, 29), 'yearly'))).toBe(iso(at(2025, 2, 28)));
    expect(iso(addCalendarMonths(at(2024, 2, 29), 12))).toBe(iso(at(2025, 2, 28)));
  });

  it('monthly window keys are byte-for-byte unchanged when the cycle is omitted (regression)', () => {
    const start = at(2026, 1, 15);
    expect(windowMonthKey(start, at(2026, 2, 14))).toBe('2026-01-15');
    expect(windowMonthKey(start, at(2026, 2, 14), 'monthly')).toBe('2026-01-15');
    expect(windowMonthKey(start, at(2026, 2, 15), 'monthly')).toBe('2026-02-15');
  });

  it('a yearly pool does NOT reset monthly — one key all year', () => {
    const start = at(2026, 1, 15);
    expect(windowMonthKey(start, at(2026, 2, 20), 'yearly')).toBe('2026-01-15');
    expect(windowMonthKey(start, at(2026, 7, 2), 'yearly')).toBe('2026-01-15');
    expect(windowMonthKey(start, at(2027, 1, 14), 'yearly')).toBe('2026-01-15');
  });

  it('the yearly pool flips to a fresh key at renewal, never before', () => {
    const start = at(2026, 1, 15);
    expect(windowMonthKey(start, at(2027, 1, 15), 'yearly')).toBe('2027-01-15');
    expect(currentWindowAnchor(start, at(2027, 8, 1), 'yearly').getTime()).toBe(
      at(2027, 1, 15).getTime(),
    );
  });

  it('a leap-day subscription keeps its clamped anniversary window', () => {
    const start = at(2024, 2, 29);
    expect(windowMonthKey(start, at(2025, 2, 27), 'yearly')).toBe('2024-02-29');
    expect(windowMonthKey(start, at(2025, 3, 1), 'yearly')).toBe('2025-02-28');
  });

  it('quota windows map a stored period to a stored window label', () => {
    expect(quotaWindowForPeriod('total')).toBe('lifetime');
    expect(quotaWindowForPeriod('monthly')).toBe('monthly');
    expect(quotaWindowForPeriod('yearly')).toBe('yearly');
  });
});

/* ------------------------------------------------------------------ *
 * PART 3/5 — the stored yearly overlay, per figure, monthly fallback
 * ------------------------------------------------------------------ */
describe('stored yearly overlay', () => {
  const card = (over: Partial<PlanCard> = {}): PlanCard =>
    ({
      id: 'starter',
      name: 'Starter',
      tagline: null,
      isPaid: true,
      sort: 2,
      prices: { monthly: 999, yearly: 11988 },
      currency: 'INR',
      limits: Object.fromEntries(MONTHLY_LIMITS.map((r) => [r.feature, r.value])),
      limitPeriods: Object.fromEntries(MONTHLY_LIMITS.map((r) => [r.feature, r.period])),
      yearlyLimits: Object.fromEntries(YEARLY_LIMITS.map((r) => [r.feature, r.value])),
      yearlyLimitPeriods: Object.fromEntries(YEARLY_LIMITS.map((r) => [r.feature, r.period])),
      features: {},
      gatewayPlanIds: { monthly: 'plan_m', yearly: 'plan_y' },
      yearlyShown: true,
      yearlyAvailable: true,
      ...over,
    }) as PlanCard;

  it('monthly view reads the monthly rows untouched', () => {
    const c = card();
    expect(cardLimits(c, 'monthly').contacts).toBe(1000);
    expect(cardLimits(c, 'monthly').bulk_messages).toBe(5000);
  });

  it('yearly view reads the STORED yearly rows', () => {
    const c = card();
    expect(cardLimits(c, 'yearly').contacts).toBe(12000);
    expect(cardLimits(c, 'yearly').bulk_messages).toBe(60000);
    expect(cardLimitPeriods(c, 'yearly').bulk_messages).toBe('yearly');
    expect(cardLimitPeriods(c, 'yearly').contacts).toBe('total');
  });

  it('a figure with no yearly row keeps its monthly value (per-figure fallback)', () => {
    const c = card();
    expect(c.yearlyLimits.team_members).toBeUndefined();
    expect(cardLimits(c, 'yearly').team_members).toBe(2);
    expect(cardLimitPeriods(c, 'yearly').team_members).toBe('total');
  });

  it('a plan with no stored yearly figures never shows yearly figures', () => {
    const c = card({ yearlyShown: false });
    expect(cardLimits(c, 'yearly').contacts).toBe(1000);
    expect(cardLimitPeriods(c, 'yearly').bulk_messages).toBe('monthly');
  });

  it('the free trial has no yearly version at all', () => {
    const c = card({
      id: 'trial',
      isPaid: false,
      yearlyShown: false,
      yearlyAvailable: false,
      prices: { monthly: 0, yearly: 0 },
    });
    expect(cardLimits(c, 'yearly')).toEqual(cardLimits(c, 'monthly'));
  });
});

/* ------------------------------------------------------------------ *
 * PART 2/3 — the yearly DISPLAY gate and the yearly PURCHASE gate are
 * separate: the stored numbers may be shown as soon as they exist, while a
 * checkout is offered as soon as the plan carries a real yearly PRICE row.
 * A gateway plan id belongs to NEITHER gate: checkout mints it on first use
 * (that is how monthly has always worked), and with no payment provider
 * configured monthly is equally unbuyable — a deployment state must not
 * disable every yearly card.
 * ------------------------------------------------------------------ */
describe('catalog yearly availability is data-driven', () => {
  const catalogTables = (over: Record<string, Row[]> = {}): Record<string, Row[]> => ({
    plans: [
      { id: 'trial', name: 'Trial', tagline: 'Free', is_paid: false, sort: 1, is_public: true },
      { id: 'starter', name: 'Starter', tagline: null, is_paid: true, sort: 2, is_public: true },
      { id: 'growth', name: 'Growth', tagline: null, is_paid: true, sort: 3, is_public: true },
      { id: 'enterprise', name: 'Enterprise', tagline: null, is_paid: true, sort: 4, is_public: true },
    ],
    plan_prices: [
      { plan_id: 'trial', billing_cycle: 'monthly', amount: 0, currency: 'INR', gateway_plan_id: null },
      { plan_id: 'starter', billing_cycle: 'monthly', amount: 999, currency: 'INR', gateway_plan_id: 'plan_m' },
      { plan_id: 'starter', billing_cycle: 'yearly', amount: 11988, currency: 'INR', gateway_plan_id: 'plan_y' },
      // Growth: yearly figures, a yearly price, and NO gateway plan id yet —
      // the pre-sync state every plan is in on a fresh install.
      { plan_id: 'growth', billing_cycle: 'monthly', amount: 1999, currency: 'INR', gateway_plan_id: 'plan_m2' },
      { plan_id: 'growth', billing_cycle: 'yearly', amount: 23988, currency: 'INR', gateway_plan_id: null },
      // Enterprise: yearly FIGURES but no yearly PRICE row → nothing to sell.
      { plan_id: 'enterprise', billing_cycle: 'monthly', amount: 2999, currency: 'INR', gateway_plan_id: 'plan_e' },
    ],
    plan_limits: MONTHLY_LIMITS,
    plan_features: [],
    plan_yearly_limits: [
      ...YEARLY_LIMITS,
      { plan_id: 'growth', feature: 'contacts', value: 120000, period: 'total' },
      { plan_id: 'growth', feature: 'bulk_messages', value: 300000, period: 'yearly' },
      { plan_id: 'enterprise', feature: 'contacts', value: 24000, period: 'total' },
    ],
    ...over,
  });

  it('shows the figures once they are stored, sells on the yearly price row', async () => {
    active = fakeDb({ tables: catalogTables() });
    const cards = await getPlanCatalog();
    const starter = cards.find((p) => p.id === 'starter')!;
    const growth = cards.find((p) => p.id === 'growth')!;
    const noPrice = cards.find((p) => p.id === 'enterprise')!;
    expect(starter.yearlyShown).toBe(true);
    expect(starter.yearlyAvailable).toBe(true);
    // A missing gateway id changes nothing — checkout creates the gateway plan
    // and stores it, exactly as it always has for monthly.
    expect(growth.gatewayPlanIds.yearly).toBeNull();
    expect(growth.yearlyShown).toBe(true);
    expect(growth.yearlyAvailable).toBe(true);
    expect(cardLimits(growth, 'yearly').contacts).toBe(120000);
    expect(cardLimitPeriods(growth, 'yearly').bulk_messages).toBe('yearly');
    // Figures without a price row: show them, never sell a ₹0 subscription.
    expect(noPrice.yearlyShown).toBe(true);
    expect(noPrice.yearlyAvailable).toBe(false);
    expect(cards.find((p) => p.id === 'trial')?.yearlyShown).toBe(false);
    expect(cards.find((p) => p.id === 'trial')?.yearlyAvailable).toBe(false);
    // the figures are still stored per cycle, not derived
    expect(starter.yearlyLimits.contacts).toBe(12000);
    expect(growth.prices.yearly).toBe(23988);
  });

  it('switches the whole cycle off with YEARLY_BILLING_ENABLED=false', async () => {
    active = fakeDb({ tables: catalogTables() });
    process.env.YEARLY_BILLING_ENABLED = 'false';
    try {
      const cards = await getPlanCatalog();
      expect(cards.every((p) => !p.yearlyAvailable && !p.yearlyShown)).toBe(true);
      // …and every card is back on its monthly numbers.
      expect(cardLimits(cards.find((p) => p.id === 'starter')!, 'yearly').contacts).toBe(1000);
    } finally {
      delete process.env.YEARLY_BILLING_ENABLED;
    }
  });

  it('degrades to monthly-only when migration 052 is not applied', async () => {
    active = fakeDb({ tables: catalogTables(), missing: ['plan_yearly_limits'] });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cards = await getPlanCatalog();
      const starter = cards.find((p) => p.id === 'starter')!;
      expect(starter.yearlyLimits).toEqual({});
      expect(starter.yearlyShown).toBe(false);
      expect(starter.yearlyAvailable).toBe(false);
      // figures stay monthly, so nothing is ever printed under a "/year" label
      expect(cardLimits(starter, 'yearly').contacts).toBe(1000);
    } finally {
      spy.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ *
 * PART 5 — enforcement reads the subscription's cycle
 * ------------------------------------------------------------------ */
describe('enforcement at yearly values', () => {
  it('a monthly subscriber never triggers a yearly read at all', async () => {
    const db = fakeDb({ tables: entitlementTables() });
    __resetPlanCacheForTests();
    const ent = await getEntitlements('acct-1', { now: at(2026, 2, 1), admin: db.client });
    expect(ent.cycle).toBe('monthly');
    expect(ent.limits.contacts).toBe(1000);
    expect(ent.limits.bulk_messages).toBe(5000);
    expect(db.reads.some((r) => r.startsWith('plan_yearly_limits:'))).toBe(false);
  });

  it('a yearly subscriber gets the stored yearly figures and the cycle', async () => {
    const db = fakeDb({ tables: entitlementTables({ subscriptions: [yearlySub()] }) });
    const ent = await getEntitlements('acct-1', { now: at(2026, 6, 1), admin: db.client });
    expect(ent.cycle).toBe('yearly');
    expect(ent.limits).toMatchObject({
      contacts: 12000,
      bulk_messages: 60000,
      templates: 120,
      quick_replies: 240,
      automation_flows: 36,
      whatsapp_forms: 36,
    });
    // per-figure fallback: no yearly team_members row → the monthly row wins
    expect(ent.limits.team_members).toBe(2);
    expect(ent.limitPeriods.bulk_messages).toBe('yearly');
    expect(ent.features.fields_tags).toBe(true);
  });

  it('blocks the create at the YEARLY cap, not the monthly one', async () => {
    const yearly = fakeDb({
      tables: entitlementTables({ subscriptions: [yearlySub()], contacts: manyContacts(12000) }),
    });
    const r = await checkLimit('acct-1', 'contacts', 1, { now: at(2026, 6, 1), admin: yearly.client });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('limit_reached');
    expect(r.limit).toBe(12000);
    expect(r.current).toBe(12000);

    // identical usage on a monthly plan blocks at 1,000 instead
    const monthly = fakeDb({ tables: entitlementTables({ contacts: manyContacts(12000) }) });
    const m = await checkLimit('acct-1', 'contacts', 1, { now: at(2026, 2, 1), admin: monthly.client });
    expect(m.allowed).toBe(false);
    expect(m.limit).toBe(1000);
  });

  it('lets one more through while under the yearly cap, and blocks a whole batch that overflows', async () => {
    const db = fakeDb({
      tables: entitlementTables({
        subscriptions: [yearlySub()],
        contacts: manyContacts(11999),
      }),
    });
    expect((await checkLimit('acct-1', 'contacts', 1, { now: at(2026, 6, 1), admin: db.client })).allowed).toBe(
      true,
    );
    // PART 5: the plan quota is checked for the FULL batch before a send.
    const over = fakeDb({
      tables: entitlementTables({
        subscriptions: [yearlySub()],
        usage_counters: [
          { id: 'u', account_id: 'acct-1', feature: 'bulk_messages', period_month: '2026-01-15', quota_window: 'yearly', value: 59999 },
        ],
      }),
    });
    const batch = await checkLimit('acct-1', 'bulk_messages', 500, {
      now: at(2026, 6, 1),
      admin: over.client,
    });
    expect(batch.allowed).toBe(false);
    expect(batch.limit).toBe(60000);
    expect(batch.current).toBe(59999);
  });

  it('an unlimited plan is never blocked, on either cycle', async () => {
    const db = fakeDb({
      tables: entitlementTables({
        subscriptions: [yearlySub({ plan_id: 'enterprise' })],
        plans: [{ id: 'enterprise', name: 'Enterprise' }],
        plan_limits: UNLIMITED_ROWS,
        plan_yearly_limits: UNLIMITED_ROWS,
      }),
    });
    const r = await checkLimit('acct-1', 'contacts', 1_000_000, {
      now: at(2026, 6, 1),
      admin: db.client,
    });
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(-1);
    expect(r.remaining).toBe(Infinity);
  });

  it('expired yearly access still blocks gated writes (read-only mode)', async () => {
    const db = fakeDb({
      tables: entitlementTables({
        subscriptions: [yearlySub({ current_period_end: iso(at(2026, 1, 16)) })],
      }),
    });
    const r = await checkLimit('acct-1', 'contacts', 1, { now: at(2026, 2, 1), admin: db.client });
    expect(r.reason).toBe('subscription_expired');
  });
});

/* ------------------------------------------------------------------ *
 * PART 5 — the yearly bulk pool is ONE window over the subscription period
 * ------------------------------------------------------------------ */
describe('yearly bulk pool', () => {
  const yearlyTablesWith = (counters: Row[]): Record<string, Row[]> =>
    entitlementTables({ subscriptions: [yearlySub()], usage_counters: counters });

  it('opens the pool on the period start with quota_window = yearly', async () => {
    const db = fakeDb({ tables: yearlyTablesWith([]) });
    await incrementUsage('acct-1', 'bulk_messages', 1000, { now: at(2026, 1, 20), admin: db.client });
    expect(db.writes.at(-1)?.record).toMatchObject({
      feature: 'bulk_messages',
      period_month: '2026-01-15',
      quota_window: 'yearly',
      value: 1000,
    });
  });

  it('keeps adding to the SAME row months later (no monthly reset, no rollover)', async () => {
    const db = fakeDb({
      tables: yearlyTablesWith([
        { id: 'uc-1', account_id: 'acct-1', feature: 'bulk_messages', period_month: '2026-01-15', quota_window: 'yearly', value: 1000 },
      ]),
    });
    await incrementUsage('acct-1', 'bulk_messages', 500, { now: at(2026, 7, 2), admin: db.client });
    const upd = db.writes.find((w) => w.method === 'update');
    expect(upd?.record.value).toBe(1500);
    expect(upd?.filters.some((f) => f.col === 'id' && f.val === 'uc-1')).toBe(true);
    expect(db.writes.some((w) => w.method === 'insert')).toBe(false);
  });

  it('reads the yearly pool from the yearly window only', async () => {
    const db = fakeDb({
      tables: yearlyTablesWith([
        // a monthly-window row from before the switch, same key on purpose
        { id: 'uc-m', account_id: 'acct-1', feature: 'bulk_messages', period_month: '2026-01-15', quota_window: 'monthly', value: 9999 },
        { id: 'uc-y', account_id: 'acct-1', feature: 'bulk_messages', period_month: '2026-01-15', quota_window: 'yearly', value: 4200 },
      ]),
    });
    const ent = await getEntitlements('acct-1', { now: at(2026, 6, 1), admin: db.client });
    expect(ent.usage.bulk_messages).toBe(4200);
  });

  it('a yearly increment never tops up a monthly counter sharing the key', async () => {
    const db = fakeDb({
      tables: yearlyTablesWith([
        { id: 'uc-m', account_id: 'acct-1', feature: 'bulk_messages', period_month: '2026-01-15', quota_window: 'monthly', value: 9999 },
      ]),
    });
    await incrementUsage('acct-1', 'bulk_messages', 10, { now: at(2026, 6, 1), admin: db.client });
    expect(db.writes.find((w) => w.method === 'insert')?.record).toMatchObject({
      quota_window: 'yearly',
      value: 10,
    });
    expect(db.writes.some((w) => w.method === 'update')).toBe(false);
  });

  it('resets at renewal — a new period start is a new key, the old pool is not read', async () => {
    const db = fakeDb({
      tables: entitlementTables({
        subscriptions: [
          yearlySub({
            current_period_start: iso(at(2027, 1, 15)),
            current_period_end: iso(at(2028, 1, 15)),
          }),
        ],
        usage_counters: [
          // last year's exhausted pool
          { id: 'uc-1', account_id: 'acct-1', feature: 'bulk_messages', period_month: '2026-01-15', quota_window: 'yearly', value: 60000 },
        ],
      }),
    });
    const ent = await getEntitlements('acct-1', { now: at(2027, 2, 1), admin: db.client });
    expect(ent.usage.bulk_messages).toBe(0);
    const r = await checkLimit('acct-1', 'bulk_messages', 60000, { now: at(2027, 2, 1), admin: db.client });
    expect(r.allowed).toBe(true);
  });

  it('a monthly plan keeps its monthly window and key (regression)', async () => {
    const db = fakeDb({
      tables: entitlementTables({
        usage_counters: [
          { id: 'uc-1', account_id: 'acct-1', feature: 'bulk_messages', period_month: '2026-01-15', quota_window: 'monthly', value: 4000 },
        ],
      }),
    });
    const ent = await getEntitlements('acct-1', { now: at(2026, 2, 1), admin: db.client });
    expect(ent.usage.bulk_messages).toBe(4000);
    await incrementUsage('acct-1', 'bulk_messages', 500, { now: at(2026, 2, 1), admin: db.client });
    expect(db.writes.find((w) => w.method === 'update')?.record.value).toBe(4500);
    // a new month is a new monthly window, so the old value is not carried
    const next = fakeDb({ tables: entitlementTables() });
    await incrementUsage('acct-1', 'bulk_messages', 100, { now: at(2026, 3, 20), admin: next.client });
    expect(next.writes.at(-1)?.record).toMatchObject({
      period_month: '2026-03-15',
      quota_window: 'monthly',
      value: 100,
    });
  });

  it('a trial pool stays lifetime (period_month NULL, quota_window lifetime)', async () => {
    const db = fakeDb({
      tables: entitlementTables({
        subscriptions: [
          subRow({ plan_id: 'trial', status: 'trialing', current_period_end: null, trial_end: iso(at(2026, 1, 22)) }),
        ],
        plan_limits: [{ plan_id: 'trial', feature: 'bulk_messages', value: 100, period: 'total' }],
      }),
    });
    await incrementUsage('acct-1', 'bulk_messages', 40, { now: at(2026, 1, 20), admin: db.client });
    expect(db.writes.at(-1)?.record).toMatchObject({
      period_month: null,
      quota_window: 'lifetime',
      value: 40,
    });
  });

  it('writes the legacy shape when the quota_window column does not exist yet', async () => {
    // 052 not applied: reads work (the column is only unknown to INSERT), so
    // wrap a fake whose inserts reject a record carrying quota_window once.
    const base = fakeDb({ tables: yearlyTablesWith([]) });
    const inserts: Row[] = [];
    const rawFrom = (base.client as unknown as { from: (t: string) => Record<string, unknown> }).from;
    const client = {
      from: (table: string) => {
        const b = rawFrom.call(base.client, table);
        b.insert = (record: Row) => {
          inserts.push(record);
          const rejected = record.quota_window !== undefined;
          return {
            then: (resolve: (v: unknown) => void) =>
              resolve(
                rejected
                  ? { data: null, error: { message: `column "quota_window" of relation "usage_counters" does not exist` } }
                  : { data: null, error: null },
              ),
          };
        };
        return b;
      },
    } as unknown as SupabaseClient;

    await incrementUsage('acct-1', 'bulk_messages', 100, { now: at(2026, 6, 1), admin: client });
    expect(inserts.map((r) => r.quota_window)).toEqual(['yearly', undefined]);
    expect(inserts.at(-1)?.value).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * PART 4 — switching / downgrade rule (pure)
 * ------------------------------------------------------------------ */
describe('yearly switch and downgrade rule', () => {
  const yearly = {
    plan_id: 'growth',
    billing_cycle: 'yearly',
    status: 'active',
    current_period_end: iso(at(2027, 1, 15)),
    trial_end: null,
  } as const;
  const base = { current: yearly, effectiveStatus: 'active' as const, currentSort: 3 };

  it('lets a monthly customer buy yearly', () => {
    expect(
      evaluateOfferingChange({
        ...base,
        current: { ...yearly, billing_cycle: 'monthly' },
        targetSort: 3,
        targetCycle: 'yearly',
      }).allowed,
    ).toBe(true);
  });

  it('lets a yearly customer upgrade to a better plan', () => {
    expect(evaluateOfferingChange({ ...base, targetSort: 4, targetCycle: 'yearly' }).allowed).toBe(true);
  });

  it('blocks a downgrade to a cheaper plan until the paid year ends', () => {
    const v = evaluateOfferingChange({ ...base, targetSort: 2, targetCycle: 'yearly' });
    expect(v.allowed).toBe(false);
    expect(v.blockedUntil).toBe(yearly.current_period_end);
  });

  it('blocks a switch back to monthly while the year is running, even upward', () => {
    expect(evaluateOfferingChange({ ...base, targetSort: 3, targetCycle: 'monthly' }).allowed).toBe(false);
    expect(evaluateOfferingChange({ ...base, targetSort: 5, targetCycle: 'monthly' }).allowed).toBe(false);
  });

  it('allows everything once the year has expired', () => {
    expect(
      evaluateOfferingChange({ ...base, effectiveStatus: 'expired', targetSort: 1, targetCycle: 'monthly' })
        .allowed,
    ).toBe(true);
  });

  it('never blocks the free trial or a brand-new account', () => {
    expect(evaluateOfferingChange({ ...base, current: null, targetSort: 1, targetCycle: 'monthly' }).allowed).toBe(
      true,
    );
    expect(
      evaluateOfferingChange({
        ...base,
        current: { ...yearly, plan_id: 'trial' },
        targetSort: 1,
        targetCycle: 'monthly',
      }).allowed,
    ).toBe(true);
  });

  it('leaves monthly customers free to change plan or cycle', () => {
    expect(
      evaluateOfferingChange({
        ...base,
        current: { ...yearly, billing_cycle: 'monthly' },
        targetSort: 1,
        targetCycle: 'monthly',
      }).allowed,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * PART 4 — no double billing
 * ------------------------------------------------------------------ */
describe('previous gateway subscription is cancelled exactly once', () => {
  const acct = 'acct-1';

  it('skips when there is no previous subscription', async () => {
    active = fakeDb({ tables: { subscriptions: [subRow()] } });
    const cancel = vi.fn(async () => ({ cancelled: true }));
    const r = await settlePreviousGatewaySubscription({
      accountId: acct,
      previousGatewaySubscriptionId: null,
      keepGatewaySubscriptionId: 'sub_new',
      cancel,
    });
    expect(r).toEqual({ attempted: false, cancelled: false, skippedReason: 'no_previous' });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('skips a renewal of the SAME gateway subscription (never self-cancels)', async () => {
    active = fakeDb({ tables: { subscriptions: [subRow({ gateway_subscription_id: 'sub_same' })] } });
    const cancel = vi.fn(async () => ({ cancelled: true }));
    const r = await settlePreviousGatewaySubscription({
      accountId: acct,
      previousGatewaySubscriptionId: 'sub_same',
      keepGatewaySubscriptionId: 'sub_same',
      cancel,
    });
    expect(r.skippedReason).toBe('same_subscription');
    expect(cancel).not.toHaveBeenCalled();
    expect(active.writes.length).toBe(0);
  });

  it('cancels the old one and clears the reference, scoped to that id', async () => {
    active = fakeDb({ tables: { subscriptions: [subRow({ gateway_subscription_id: 'sub_old' })] } });
    const cancel = vi.fn(async () => ({ cancelled: true }));
    const r = await settlePreviousGatewaySubscription({
      accountId: acct,
      previousGatewaySubscriptionId: 'sub_old',
      keepGatewaySubscriptionId: 'sub_new',
      cancel,
    });
    expect(cancel).toHaveBeenCalledWith('sub_old');
    expect(r.cancelled).toBe(true);
    const upd = active.writes.find((w) => w.table === 'subscriptions' && w.method === 'update');
    expect(upd?.record.gateway_subscription_id).toBeNull();
    expect(upd?.filters.some((f) => f.col === 'gateway_subscription_id' && f.val === 'sub_old')).toBe(true);
  });

  it('treats "already cancelled" as success, so a replayed webhook is a no-op', async () => {
    active = fakeDb({ tables: { subscriptions: [subRow()] } });
    const r = await settlePreviousGatewaySubscription({
      accountId: acct,
      previousGatewaySubscriptionId: 'sub_old',
      keepGatewaySubscriptionId: 'sub_new',
      cancel: async () => ({ cancelled: false, alreadyInactive: true }),
    });
    expect(r.cancelled).toBe(true);
  });

  it('reads the stored id when the caller does not pass one', async () => {
    active = fakeDb({ tables: { subscriptions: [subRow({ gateway_subscription_id: 'sub_old' })] } });
    const cancel = vi.fn(async () => ({ cancelled: true }));
    const r = await settlePreviousGatewaySubscription({
      accountId: acct,
      keepGatewaySubscriptionId: 'sub_new',
      cancel,
    });
    expect(cancel).toHaveBeenCalledWith('sub_old');
    expect(r.cancelled).toBe(true);
  });

  it('keeps the reference and warns when the gateway fails — a paid activation is never blocked', async () => {
    active = fakeDb({ tables: { subscriptions: [subRow({ gateway_subscription_id: 'sub_old' })] } });
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(' '));
    });
    try {
      const r = await settlePreviousGatewaySubscription({
        accountId: acct,
        previousGatewaySubscriptionId: 'sub_old',
        keepGatewaySubscriptionId: 'sub_new',
        cancel: async () => ({ cancelled: false, error: '503' }),
      });
      expect(r).toEqual({ attempted: true, cancelled: false, error: '503' });
      expect(errs.some((e) => e.includes('DOUBLE-BILLING RISK'))).toBe(true);
      expect(active.writes.length).toBe(0); // reference kept for a retry
    } finally {
      spy.mockRestore();
    }
  });
});
