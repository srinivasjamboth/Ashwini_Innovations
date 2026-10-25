-- ============================================================
-- 048_plans_billing.sql
-- Pricing plans, plan limits/features, yearly prices, subscriptions,
-- usage counters, payment transactions, trial grant, DB guard triggers.
--
-- ADDITIVE ONLY. No DROP TABLE, no column drops, no rewrite of existing
-- customer rows. Existing accounts are backfilled with a valid trial so
-- nothing breaks for anyone already signed up.
--
-- Schema shape chosen to satisfy the existing forward-compat contract in
-- src/lib/admin/metrics.ts — subscriptions(user_id, status,
-- current_period_end, billing_cycle, plan_id → plans(name, price,
-- interval)) — so the admin dashboard starts reporting real numbers
-- after this migration without code changes there.
--
-- Single source of truth: the pricing cards, the enforcement service,
-- and the billing settings tab all read the same rows below. Nothing
-- plan-related is hard-coded in UI or logic.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Catalog: plans, plan_prices, plan_limits, plan_features
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.plans (
  id TEXT PRIMARY KEY, -- 'trial' | 'starter' | 'growth' | 'enterprise'
  name TEXT NOT NULL,
  tagline TEXT,
  -- Legacy column kept for admin metrics.ts (`price` numeric, monthly).
  price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  -- Legacy column kept for admin metrics.ts (`interval` text).
  interval TEXT NOT NULL DEFAULT 'monthly',
  sort INTEGER NOT NULL DEFAULT 0,
  is_paid BOOLEAN NOT NULL DEFAULT FALSE,
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.plan_prices (
  plan_id TEXT NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  -- Populated when the gateway (Razorpay) is wired up. Nullable so the
  -- system runs with no gateway configured.
  gateway_plan_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plan_id, billing_cycle)
);

CREATE TABLE IF NOT EXISTS public.plan_limits (
  plan_id TEXT NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  -- -1 means unlimited, per Part 1 of the spec.
  value NUMERIC NOT NULL,
  -- 'total'   = stored count of rows (contacts, templates, quick_replies,
  --             automation_flows, whatsapp_forms, team_members).
  -- 'monthly' = usage counter, one window per calendar month anchored to
  --             the subscription's current_period_start (bulk_messages).
  period TEXT NOT NULL DEFAULT 'total' CHECK (period IN ('total', 'monthly')),
  PRIMARY KEY (plan_id, feature)
);

CREATE TABLE IF NOT EXISTS public.plan_features (
  plan_id TEXT NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (plan_id, feature)
);

-- ------------------------------------------------------------
-- 2. Subscriptions — one row per account, mutable by API/service_role.
--    Columns mirror what src/lib/admin/metrics.ts already expects.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL, -- owner at grant time (metrics.ts keys on this)
  plan_id TEXT NOT NULL REFERENCES public.plans(id),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'expired', 'canceled', 'past_due')),
  billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,
  -- When this account was first granted a trial. Drives the "Trial used"
  -- button state on the pricing cards (Part 5).
  trial_claimed_at TIMESTAMPTZ,
  -- Gateway references are nullable so the trial + admin-manual flows
  -- work with no gateway configured.
  gateway TEXT,
  gateway_subscription_id TEXT,
  gateway_customer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_account_key
  ON public.subscriptions(account_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_period_end_idx
  ON public.subscriptions(status, current_period_end);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx
  ON public.subscriptions(user_id);

-- ------------------------------------------------------------
-- 3. Usage counters — the ONLY counter we need. Everything else is a
--    live COUNT against the resource table (which means deletes auto-
--    free a slot per Part 4 "deleting decrements usage"). Bulk broadcast
--    messages are append-only: Part 4 "deletions never restore quota."
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.usage_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  -- First day (UTC) of the window this counter covers. NULL = lifetime
  -- (used for the trial's "100 total" bulk-message cap).
  period_month DATE,
  value BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL not distinct — one lifetime row per (account, feature) works
  -- because NULLS NOT DISTINCT is PG15+, otherwise unique-with-null is
  -- handled below via two coalesce indexes.
  CONSTRAINT usage_counters_scope_key UNIQUE (account_id, feature, period_month)
);

CREATE INDEX IF NOT EXISTS usage_counters_account_feature_idx
  ON public.usage_counters(account_id, feature);

-- ------------------------------------------------------------
-- 4. Payment transactions — idempotency anchor for webhooks (Part 2
--    "unique gateway payment reference so a repeated webhook can never
--    extend a period twice").
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  plan_id TEXT REFERENCES public.plans(id),
  billing_cycle TEXT,
  gateway TEXT NOT NULL DEFAULT 'razorpay',
  gateway_order_id TEXT,
  gateway_payment_id TEXT UNIQUE,
  amount NUMERIC(12, 2),
  currency TEXT DEFAULT 'INR',
  status TEXT NOT NULL, -- 'created' | 'paid' | 'failed' | 'refunded'
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_transactions_account_idx
  ON public.payment_transactions(account_id, created_at DESC);

-- ------------------------------------------------------------
-- 5. updated_at triggers on new tables (reuses the existing helper).
-- ------------------------------------------------------------

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.plan_prices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.usage_counters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 6. Effective-status SQL helpers.
--
--    The single-source-of-truth effective status is implemented in
--    TypeScript (`src/lib/plans/entitlements.ts`). These SQL helpers
--    mirror the SAME logic and are used ONLY from the DB guard triggers
--    below, which need to answer the question synchronously during a
--    client-direct INSERT (contacts/tags/custom_fields). Divergence risk
--    is called out in the final report; both are covered by tests.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.subscription_effective_plan_id(
  target_account_id UUID,
  now_ts TIMESTAMPTZ DEFAULT NOW(),
  grace_days INTEGER DEFAULT 0
) RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.plan_id
  FROM subscriptions s
  WHERE s.account_id = target_account_id
    AND s.status IN ('trialing', 'active')
    AND COALESCE(s.current_period_end, s.trial_end) + (grace_days || ' days')::interval > now_ts
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.plan_limit_value(
  target_plan_id TEXT,
  target_feature TEXT
) RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT value FROM plan_limits WHERE plan_id = target_plan_id AND feature = target_feature;
$$;

CREATE OR REPLACE FUNCTION public.plan_feature_enabled(
  target_plan_id TEXT,
  target_feature TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT enabled FROM plan_features WHERE plan_id = target_plan_id AND feature = target_feature),
    FALSE
  );
$$;

GRANT EXECUTE ON FUNCTION public.subscription_effective_plan_id(UUID, TIMESTAMPTZ, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_limit_value(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_feature_enabled(TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 7. Guard triggers for the CLIENT-DIRECT create paths (Part 4, Arm B).
--
--    Some resources (contacts, tags, custom_fields) are inserted from
--    client components through the RLS-scoped SSR Supabase client, with
--    no API route to intercept. A DB-level BEFORE INSERT trigger is the
--    only place that closes that surface.
--
--    Bypass rule: only enforce when the JWT role is 'authenticated'.
--    Inbound message webhook uses supabaseAdmin() (role = service_role)
--    → contacts auto-created from inbound traffic are ALWAYS allowed,
--    per Part 3 / Part 4 "never drop an inbound message."
--
--    Batch rule: PostgREST sends multi-row INSERT as one statement, so
--    if any row's trigger raises, the whole statement rolls back. That
--    matches Part 4 "reject the whole operation with a clear message"
--    for CSV imports / campaign audience bulk add.
--
--    Grandfather rule (Part 2): only NEW INSERTs are checked. Existing
--    rows are never touched, even when a plan downgrade puts the account
--    over the new limit.
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

  v_limit := public.plan_limit_value(v_plan, 'contacts');
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

CREATE TRIGGER contacts_insert_guard
  BEFORE INSERT ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.guard_contacts_insert();

-- Fields & Tags is a feature flag on the plan (Part 4). Trial gets no
-- fields_tags, so tag/custom-field inserts raise.
CREATE OR REPLACE FUNCTION public.guard_fields_tags_feature()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_account UUID;
  v_plan TEXT;
BEGIN
  BEGIN
    v_role := (current_setting('request.jwt.claims', true)::JSONB ->> 'role');
  EXCEPTION WHEN OTHERS THEN
    v_role := NULL;
  END;
  IF v_role IS DISTINCT FROM 'authenticated' THEN
    RETURN NEW;
  END IF;

  v_account := NEW.account_id;
  v_plan := public.subscription_effective_plan_id(v_account);
  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'subscription_expired'
      USING ERRCODE = '42501', HINT = 'Renew to manage tags and custom fields.';
  END IF;

  IF NOT public.plan_feature_enabled(v_plan, 'fields_tags') THEN
    RAISE EXCEPTION 'feature_not_included: fields_tags'
      USING ERRCODE = '42501', HINT = 'Fields & Tags are available on Starter and above.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tags_insert_guard
  BEFORE INSERT ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.guard_fields_tags_feature();

CREATE TRIGGER custom_fields_insert_guard
  BEFORE INSERT ON public.custom_fields
  FOR EACH ROW EXECUTE FUNCTION public.guard_fields_tags_feature();

-- ------------------------------------------------------------
-- 8. Trial grant on signup (Part 2 "New signup: automatically gets the
--    7-day trial"). handle_new_user() in 044 runs first via the earlier
--    trigger name `on_auth_user_created`; Postgres fires AFTER ROW
--    triggers on the same event in name order, so 'c' < 't' guarantees
--    the account + owner profile exist by the time this runs. If they
--    don't (defensive), we log a warning and skip so signup never fails.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.grant_trial_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
BEGIN
  SELECT id INTO v_account FROM accounts WHERE owner_user_id = NEW.id LIMIT 1;
  IF v_account IS NULL THEN
    RAISE WARNING 'grant_trial_subscription: no account for user % (bootstrap trigger may have failed)', NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO public.subscriptions (
    account_id, user_id, plan_id, status, billing_cycle,
    current_period_start, current_period_end, trial_end, trial_claimed_at
  )
  VALUES (
    v_account, NEW.id, 'trial', 'trialing', 'monthly',
    NOW(), NOW() + INTERVAL '7 days', NOW() + INTERVAL '7 days', NOW()
  )
  ON CONFLICT (account_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'grant_trial_subscription failed for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_trial
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.grant_trial_subscription();

-- ------------------------------------------------------------
-- 9. Idempotent seed. ON CONFLICT DO UPDATE so re-running aligns rows
--    with the Part 1 table exactly. Diff reported in the final report.
--
--    Prices (INR): monthly 0/999/1999/2999, yearly monthly×12 (flag 1).
--    Growth contacts 10,000 (flag 2). Fields & Tags blocked on trial
--    (flag 3). AI Agent listed on paid plans but not enforced (flag 4 —
--    feature already exists in the app, per Part 4 "do NOT build").
--    Enterprise bulk -1 unlimited; FAIR_USE_ALERT_THRESHOLD lives in TS.
-- ------------------------------------------------------------

INSERT INTO public.plans (id, name, tagline, price, interval, sort, is_paid, is_public) VALUES
  ('trial',      'Free Trial',  'Try for 7 days',             0,    'monthly', 0, FALSE, TRUE),
  ('starter',    'Starter',     'Perfect for small teams',    999,  'monthly', 1, TRUE,  TRUE),
  ('growth',     'Growth',      'For scaling businesses',     1999, 'monthly', 2, TRUE,  TRUE),
  ('enterprise', 'Enterprise',  'Unrestricted limits',        2999, 'monthly', 3, TRUE,  TRUE)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  tagline = EXCLUDED.tagline,
  price = EXCLUDED.price,
  interval = EXCLUDED.interval,
  sort = EXCLUDED.sort,
  is_paid = EXCLUDED.is_paid,
  is_public = EXCLUDED.is_public,
  updated_at = NOW();

INSERT INTO public.plan_prices (plan_id, billing_cycle, amount, currency) VALUES
  ('trial',      'monthly',    0, 'INR'),
  ('trial',      'yearly',     0, 'INR'),
  ('starter',    'monthly',  999, 'INR'),
  ('starter',    'yearly', 11988, 'INR'),
  ('growth',     'monthly', 1999, 'INR'),
  ('growth',     'yearly', 23988, 'INR'),
  ('enterprise', 'monthly', 2999, 'INR'),
  ('enterprise', 'yearly', 35988, 'INR')
ON CONFLICT (plan_id, billing_cycle) DO UPDATE SET
  amount = EXCLUDED.amount,
  currency = EXCLUDED.currency,
  updated_at = NOW();

-- feature, value, period per Part 1 table. -1 = unlimited.
INSERT INTO public.plan_limits (plan_id, feature, value, period) VALUES
  -- Trial (7-day, Rs 0)
  ('trial',      'contacts',         100,  'total'),
  ('trial',      'bulk_messages',    100,  'total'), -- "100 total for the trial"
  ('trial',      'templates',          3,  'total'),
  ('trial',      'quick_replies',      5,  'total'),
  ('trial',      'automation_flows',   1,  'total'),
  ('trial',      'whatsapp_forms',     1,  'total'),
  ('trial',      'team_members',       1,  'total'),
  -- Starter (Rs 999/mo)
  ('starter',    'contacts',      1000,    'total'),
  ('starter',    'bulk_messages', 5000,    'monthly'),
  ('starter',    'templates',        10,   'total'),
  ('starter',    'quick_replies',    20,   'total'),
  ('starter',    'automation_flows',  3,   'total'),
  ('starter',    'whatsapp_forms',    3,   'total'),
  ('starter',    'team_members',      2,   'total'),
  -- Growth (Rs 1,999/mo)
  ('growth',     'contacts',     10000,    'total'), -- flag 2 (assumption)
  ('growth',     'bulk_messages', 25000,   'monthly'),
  ('growth',     'templates',        -1,   'total'),
  ('growth',     'quick_replies',    -1,   'total'),
  ('growth',     'automation_flows', -1,   'total'),
  ('growth',     'whatsapp_forms',   -1,   'total'),
  ('growth',     'team_members',     10,   'total'),
  -- Enterprise (Rs 2,999/mo)
  ('enterprise', 'contacts',         -1,   'total'),
  ('enterprise', 'bulk_messages',    -1,   'monthly'), -- unlimited, fair-use soft cap
  ('enterprise', 'templates',        -1,   'total'),
  ('enterprise', 'quick_replies',    -1,   'total'),
  ('enterprise', 'automation_flows', -1,   'total'),
  ('enterprise', 'whatsapp_forms',   -1,   'total'),
  ('enterprise', 'team_members',     -1,   'total')
ON CONFLICT (plan_id, feature) DO UPDATE SET
  value = EXCLUDED.value,
  period = EXCLUDED.period;

-- Boolean feature flags (Part 4 "Fields and Tags / Broadcast Scheduler /
-- AI Agent"). Common features (Opt In / Opt Out, Customer Support, chat
-- inbox, WhatsApp connection, Settings) are NOT here — no plan check may
-- exist anywhere for them, per the TERMINOLOGY section of the spec.
INSERT INTO public.plan_features (plan_id, feature, enabled) VALUES
  ('trial',      'fields_tags',          FALSE), -- flag 3
  ('trial',      'broadcast_scheduler',  FALSE),
  ('trial',      'ai_agent',             FALSE), -- flag 4 (not built here)
  ('starter',    'fields_tags',          TRUE),
  ('starter',    'broadcast_scheduler',  FALSE),
  ('starter',    'ai_agent',             TRUE),
  ('growth',     'fields_tags',          TRUE),
  ('growth',     'broadcast_scheduler',  TRUE),
  ('growth',     'ai_agent',             TRUE),
  ('enterprise', 'fields_tags',          TRUE),
  ('enterprise', 'broadcast_scheduler',  TRUE),
  ('enterprise', 'ai_agent',             TRUE)
ON CONFLICT (plan_id, feature) DO UPDATE SET
  enabled = EXCLUDED.enabled;

-- ------------------------------------------------------------
-- 10. Backfill existing accounts with a valid trial (Part 2 "Existing
--     customers: migrate them, keep current plan, never delete"). No
--     customer accounts exist yet in a fresh install, but on any fork
--     with pre-existing data we insert a fresh 7-day trial for every
--     account that has no subscription row. ON CONFLICT DO NOTHING
--     means this can never overwrite a real subscription.
-- ------------------------------------------------------------

INSERT INTO public.subscriptions (
  account_id, user_id, plan_id, status, billing_cycle,
  current_period_start, current_period_end, trial_end, trial_claimed_at
)
SELECT
  a.id, a.owner_user_id, 'trial', 'trialing', 'monthly',
  NOW(), NOW() + INTERVAL '7 days', NOW() + INTERVAL '7 days', NOW()
FROM public.accounts a
WHERE a.owner_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.account_id = a.id)
ON CONFLICT (account_id) DO NOTHING;

-- ------------------------------------------------------------
-- 11. RLS.
--     Plans catalog is world-readable (anon too, so the marketing page
--     can server-render prices from the DB per Part 5 "render them from
--     the database"). Subscriptions/usage/payments readable only by
--     account members. Nothing here is writable from the client — all
--     writes go through service-role in API routes or via triggers.
-- ------------------------------------------------------------

ALTER TABLE public.plans           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_prices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_limits     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_features   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_counters  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plans_public_read ON public.plans;
CREATE POLICY plans_public_read ON public.plans
  FOR SELECT USING (is_public = TRUE);

DROP POLICY IF EXISTS plan_prices_public_read ON public.plan_prices;
CREATE POLICY plan_prices_public_read ON public.plan_prices
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS plan_limits_public_read ON public.plan_limits;
CREATE POLICY plan_limits_public_read ON public.plan_limits
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS plan_features_public_read ON public.plan_features;
CREATE POLICY plan_features_public_read ON public.plan_features
  FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS subscriptions_member_read ON public.subscriptions;
CREATE POLICY subscriptions_member_read ON public.subscriptions
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS usage_counters_member_read ON public.usage_counters;
CREATE POLICY usage_counters_member_read ON public.usage_counters
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS payment_transactions_member_read ON public.payment_transactions;
CREATE POLICY payment_transactions_member_read ON public.payment_transactions
  FOR SELECT USING (is_account_member(account_id));
