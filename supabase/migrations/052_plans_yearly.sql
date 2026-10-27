-- ============================================================
-- 052_plans_yearly.sql
--
-- YEARLY BILLING — data layer. Additive + idempotent (safe to re-run).
--
-- The owner's rule: a year has 12 months, so every NUMBER on a plan is
-- shown and enforced as its yearly figure. This is implemented as DATA,
-- not as runtime math:
--
--   1. `plan_yearly_multipliers` is the single configuration map
--      (figure -> multiplier). It is read ONCE, by the seed below.
--   2. The seed writes EXPLICIT yearly numbers into `plan_yearly_limits`
--      (and refreshes the yearly `plan_prices` rows).
--   3. Pricing cards, enforcement, the billing tab and the admin panel
--      all read those STORED rows. Nothing multiplies at runtime.
--
-- Changing a multiplier later is a data change only: edit the map row
-- and re-run this file — Section 4 re-derives the stored yearly figures
-- from whatever the map says. Set a multiplier to 1 and that figure
-- simply becomes the monthly number again.
--
-- MONTHLY IS NEVER TOUCHED. `plan_limits` keeps its rows, its primary
-- key and its CHECK constraint exactly as migration 048 seeded them, so
-- 048 stays re-runnable (its idempotent seed uses
-- `ON CONFLICT (plan_id, feature)`, which a billing_cycle column on this
-- table would have broken). Where a yearly figure is missing for a
-- figure, enforcement falls back to the monthly row — see
-- `plan_limit_value_cycle()`.
-- ============================================================

-- ------------------------------------------------------------
-- 1. THE CONFIGURATION MAP — one multiplier per figure.
--    'price' drives the yearly plan_prices rows; the rest drive
--    plan_yearly_limits. 'bulk_messages' is a NUMBER and a WINDOW:
--    60,000 spread over a year is a yearly pool, not 60,000 a month,
--    so its limits row carries period 'yearly' (Section 3).
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.plan_yearly_multipliers (
  feature    TEXT PRIMARY KEY,
  multiplier NUMERIC NOT NULL CHECK (multiplier >= 1),
  note       TEXT
);

INSERT INTO public.plan_yearly_multipliers (feature, multiplier, note) VALUES
  ('price',            12, 'Yearly price = monthly x 12, no discount (flag 3).'),
  ('contacts',         12, 'Cap on stored rows, x12 (flag 1).'),
  ('bulk_messages',    12, 'Yearly pool over the subscription period (flag 2).'),
  ('templates',        12, 'Cap on stored rows, x12 (flag 1).'),
  ('quick_replies',    12, 'Cap on stored rows, x12 (flag 1).'),
  ('automation_flows', 12, 'Cap on stored rows, x12 (flag 1).'),
  ('whatsapp_forms',   12, 'Cap on stored rows, x12 (flag 1).'),
  ('team_members',     12, 'Cap on seats, x12 (flag 1).')
ON CONFLICT (feature) DO UPDATE SET
  multiplier = EXCLUDED.multiplier,
  note       = EXCLUDED.note;

-- ------------------------------------------------------------
-- 2. STORED YEARLY LIMITS — one row per (plan, figure).
--    `value = -1` keeps meaning unlimited. -1 x 12 stays -1 so an
--    unlimited figure can never become finite by arithmetic.
--
--    The TRIAL is deliberately excluded: the free trial has no yearly
--    version, so it keeps exactly the 048 rows (and the cards keep
--    showing its monthly/total wording).
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.plan_yearly_limits (
  plan_id    TEXT NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  feature    TEXT NOT NULL,
  value      NUMERIC NOT NULL,
  -- 'total'   = stored-count cap (unchanged by cycle, only the number grows)
  -- 'yearly'  = one pool spanning the subscription period (period start -> end)
  -- 'monthly' = allowed for a plan that wants a monthly reset on a yearly bill
  period     TEXT NOT NULL DEFAULT 'total' CHECK (period IN ('total', 'monthly', 'yearly')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plan_id, feature)
);

-- ------------------------------------------------------------
-- 3. usage_counters gains an explicit WINDOW, so a monthly pool and a
--    yearly pool can live in the same table with the same reader.
--
--    `period_month` already held the first day of the window; for a
--    yearly plan the window also starts on a date (the 12-month
--    anniversary of the period start), so the two would otherwise be
--    indistinguishable — a monthly window starting 2026-10-25 and a
--    yearly window starting 2026-10-25 would collide on the same row and
--    silently share a counter. `quota_window` makes them distinct, and
--    lets one code path serve both cycles.
-- ------------------------------------------------------------

ALTER TABLE public.usage_counters
  ADD COLUMN IF NOT EXISTS quota_window TEXT NOT NULL DEFAULT 'monthly'
    CHECK (quota_window IN ('lifetime', 'monthly', 'yearly'));

-- Rows written before this migration were either a calendar-month window
-- (period_month set) or the trial's lifetime pool (period_month NULL).
UPDATE public.usage_counters SET quota_window = 'lifetime' WHERE period_month IS NULL;
UPDATE public.usage_counters SET quota_window = 'monthly'  WHERE period_month IS NOT NULL;

-- The scope key must include the window (see above). Superset of the old
-- key, so no existing row can violate it.
ALTER TABLE public.usage_counters
  DROP CONSTRAINT IF EXISTS usage_counters_scope_key;
ALTER TABLE public.usage_counters
  ADD CONSTRAINT usage_counters_scope_key
  UNIQUE (account_id, feature, quota_window, period_month);

COMMENT ON COLUMN public.usage_counters.quota_window IS
  'Which window the period_month date starts: lifetime (never resets), monthly (calendar-month window) or yearly (subscription-period pool).';

-- ------------------------------------------------------------
-- 4. THE SEED — read the map once, store explicit yearly figures.
--
--    Every 'monthly' limit becomes a 'yearly' pool on the yearly row:
--    the bulk-message quota must be measured across the subscription
--    period, reset at renewal, with no monthly reset and no rollover.
--    Every 'total' limit stays 'total' — only its cap grows.
-- ------------------------------------------------------------

INSERT INTO public.plan_yearly_limits (plan_id, feature, value, period)
SELECT
  l.plan_id,
  l.feature,
  CASE WHEN l.value = -1 THEN -1
       ELSE ROUND(l.value * m.multiplier) END,
  CASE WHEN l.period = 'monthly' THEN 'yearly' ELSE 'total' END
FROM public.plan_limits l
JOIN public.plan_yearly_multipliers m ON m.feature = l.feature
WHERE l.plan_id <> 'trial'
ON CONFLICT (plan_id, feature) DO UPDATE SET
  value      = EXCLUDED.value,
  period     = EXCLUDED.period,
  updated_at = NOW();

-- Yearly PRICES, from the same map. Monthly rows are the input; the
-- yearly rows already seeded by 048 are refreshed to match the map, so
-- re-running this file is the single way prices change (no code).
UPDATE public.plan_prices y
SET
  amount     = ROUND(m.amount * mp.multiplier, 2),
  updated_at = NOW()
FROM public.plan_prices m
JOIN public.plan_yearly_multipliers mp ON mp.feature = 'price'
WHERE y.billing_cycle = 'yearly'
  AND m.billing_cycle = 'monthly'
  AND m.plan_id       = y.plan_id;

-- ------------------------------------------------------------
-- 5. CYCLE-AWARE SQL READ HELPERS.
--
--    The TypeScript engine (src/lib/plans/entitlements.ts) is still the
--    single source of truth; these mirror it for the DB guard triggers,
--    which must answer synchronously during a client-direct INSERT.
--    `plan_limit_value_cycle` is the fallback rule made executable:
--    yearly row if it exists, otherwise the monthly row.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.subscription_billing_cycle(
  target_account_id UUID,
  now_ts TIMESTAMPTZ DEFAULT NOW(),
  grace_days INTEGER DEFAULT 0
) RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.billing_cycle
  FROM subscriptions s
  WHERE s.account_id = target_account_id
    AND s.status IN ('trialing', 'active')
    AND COALESCE(s.current_period_end, s.trial_end) + (grace_days || ' days')::interval > now_ts
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.plan_limit_value_cycle(
  target_plan_id TEXT,
  target_feature TEXT,
  target_cycle   TEXT
) RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN target_cycle = 'yearly' THEN COALESCE(yl.value, ml.value)
    ELSE ml.value
  END
  FROM (SELECT value FROM plan_limits
         WHERE plan_id = target_plan_id AND feature = target_feature) ml
  LEFT JOIN (SELECT value FROM plan_yearly_limits
             WHERE plan_id = target_plan_id AND feature = target_feature) yl
    ON TRUE;
$$;

GRANT EXECUTE ON FUNCTION public.subscription_billing_cycle(UUID, TIMESTAMPTZ, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_limit_value_cycle(TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. contacts guard: resolve the account's cycle, then its limit.
--
--    The only DB guard that reads a NUMBER (the tags / custom_fields
--    guards read the fields_tags boolean flag, which is identical on
--    both cycles). Body is otherwise byte-for-byte the 048 version —
--    same role bypass, same unlimited handling, same message.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_contacts_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_plan TEXT;
  v_cycle TEXT;
  v_limit NUMERIC;
  v_count BIGINT;
BEGIN
  BEGIN
    v_role := (current_setting('request.jwt.claims', true)::JSONB ->> 'role');
  EXCEPTION WHEN OTHERS THEN
    v_role := NULL;
  END;

  -- Enforce only for authenticated (client-direct) inserts. Service-role
  -- (inbound webhook, admin backfill) and internal postgres (migrations)
  -- bypass. Anon should never hit this path but is bypassed too.
  IF v_role IS DISTINCT FROM 'authenticated' THEN
    RETURN NEW;
  END IF;

  v_plan := public.subscription_effective_plan_id(NEW.account_id);
  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'subscription_expired'
      USING ERRCODE = '42501', HINT = 'Renew your subscription to add contacts.';
  END IF;

  v_cycle := COALESCE(public.subscription_billing_cycle(NEW.account_id), 'monthly');
  v_limit := public.plan_limit_value_cycle(v_plan, 'contacts', v_cycle);
  IF v_limit IS NULL OR v_limit = -1 THEN
    RETURN NEW; -- unlimited
  END IF;

  SELECT COUNT(*) INTO v_count FROM contacts WHERE account_id = NEW.account_id;
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'limit_reached for contacts (max %, current %)', v_limit, v_count
      USING ERRCODE = '42501', HINT = 'Upgrade plan or delete existing contacts to free a slot.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_insert_guard ON public.contacts;
CREATE TRIGGER contacts_insert_guard
  BEFORE INSERT ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.guard_contacts_insert();

-- ------------------------------------------------------------
-- 7. updated_at trigger + RLS. The yearly table is world-readable
--    exactly like plan_limits, so the marketing pricing page can render
--    yearly figures from the DB (never from a client-side multiply).
-- ------------------------------------------------------------

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.plan_yearly_limits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.plan_yearly_limits  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_yearly_multipliers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_yearly_limits_public_read ON public.plan_yearly_limits;
CREATE POLICY plan_yearly_limits_public_read ON public.plan_yearly_limits
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS plan_yearly_multipliers_public_read ON public.plan_yearly_multipliers;
CREATE POLICY plan_yearly_multipliers_public_read ON public.plan_yearly_multipliers
  FOR SELECT USING (TRUE);

-- ------------------------------------------------------------
-- 8. What this leaves for the caller (Part 2 of the brief):
--    plan_prices.gateway_plan_id stays NULL for every row. Razorpay plan
--    ids are created through the gateway itself and stored by
--    POST /api/billing/gateway/sync-plans — a migration cannot reach the
--    network. Until a yearly gateway plan id exists for a plan, that
--    plan's yearly option is disabled in the UI.
-- ------------------------------------------------------------
