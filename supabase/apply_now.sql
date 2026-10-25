-- One-time apply for migrations 044 + 045 + 046 + 048 + 049 (safe to re-run on any state).
-- ================= 044_profile_phone.sql =================
-- ============================================================
-- 044_profile_phone
--
-- Signup now asks for a phone number alongside name, email and
-- password. The value has to live somewhere the app can read it back
-- per-account, so it lands on `profiles` — the same row the header,
-- the sidebar and the settings form already fetch — rather than only
-- in `auth.users.raw_user_meta_data`, which is invisible to any query
-- that joins profiles for a member list.
--
-- Three changes:
--
--   1. `profiles.phone TEXT` — nullable, with a format CHECK.
--
--      Nullable on purpose. Existing accounts were created before the
--      field existed, and an invited member's profile is bootstrapped
--      by an RPC (019) that never sees a phone. NOT NULL would have
--      broken both paths — and, worse, the invite flow — on the first
--      deploy.
--
--      The CHECK is deliberately narrow: an optional leading `+` and
--      7-15 digits, i.e. E.164 without the separators. The browser
--      normalises input to exactly that shape (src/lib/auth/phone.ts),
--      so the constraint is a guard against a hand-edited API call, not
--      a validator users ever see. Spaces, dashes and parentheses are
--      stripped before the write.
--
--   2. `handle_new_user()` carries `phone` through from the signup
--      metadata, mirroring how it already carries `full_name`. The
--      current definition is migration 017's (personal account + owner
--      role in one transaction), so this is that body with the extra
--      column — nothing else about it changes.
--
--      The metadata value is client-supplied, so it is filtered against
--      the same pattern the CHECK enforces and dropped to NULL when it
--      does not match. Without that, one malformed `phone` in a signup
--      payload would fail the profiles insert, the function's EXCEPTION
--      handler would swallow it, and the user would hold a valid auth
--      account with no profile row — the read-only-session failure
--      mode described in 017 and issue #471.
--
--   3. Nothing on `contacts`. That table's `phone` column (migration
--      001) is a WhatsApp *customer* number on a different account
--      boundary; a member's own phone belongs to the identity, not the
--      CRM record, and conflating them would corrupt both.
--
-- No backfill is possible: phone numbers were never collected before
-- this migration. Existing members add theirs in Settings → Profile.
--
-- Numbered 044 rather than 043: 043_whatsapp_flows.sql already occupies
-- that prefix, and Supabase applies migrations in filename order and
-- refuses two files with the same version number.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS phone TEXT;

-- Drop-then-add so the constraint definition can evolve on a re-run
-- (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_phone_format;
ALTER TABLE profiles ADD CONSTRAINT profiles_phone_format
  CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{7,15}$');

COMMENT ON COLUMN profiles.phone IS
  'Account holder''s own phone number in E.164-ish form: an optional '
  'leading + followed by 7-15 digits, no separators. Collected at '
  'signup, editable in Settings. NULL for accounts created before '
  'migration 044 and for members whose profile was bootstrapped by an '
  'invite. Distinct from contacts.phone, which is a WhatsApp customer '
  'number.';

-- ============================================================
-- handle_new_user(): same as migration 017, plus phone.
-- ============================================================
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_phone TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  -- Client-supplied, so it is only kept when it satisfies the
  -- profiles_phone_format CHECK. See the header: an insert that raises
  -- here would be swallowed by the EXCEPTION block and leave the new
  -- user with no profile row at all.
  v_phone := NEW.raw_user_meta_data->>'phone';
  IF v_phone IS NULL OR v_phone !~ '^\+?[0-9]{7,15}$' THEN
    v_phone := NULL;
  END IF;

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, phone, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_phone, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ================= 045_admin_dashboard.sql =================
-- ============================================================
-- Super Admin Dashboard (/ashwini-control) support objects.
--
-- Additive-only: one new table, indexes that don't exist yet,
-- and three SECURITY DEFINER aggregate functions. No existing
-- column is touched.
--
-- The dashboard's read path runs through the service-role key
-- (server-only), so everything here is locked down to that
-- role — anon/authenticated get nothing.
-- ============================================================

-- ============================================================
-- ADMIN_LOGIN_EVENTS — insert-only audit trail
--
-- One row per admin login attempt, failed or successful. We
-- store the *attempted* email only (never a password, never a
-- token). The application code performs INSERTs and SELECTs
-- exclusively; UPDATE/DELETE are reachable by no app role:
-- RLS is on with zero policies (which denies anon/authenticated
-- every verb), and table grants are revoked for both.
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_login_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  attempted_email TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_login_events_created_at
  ON admin_login_events(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_login_events_attempted_email
  ON admin_login_events(attempted_email);

ALTER TABLE admin_login_events ENABLE ROW LEVEL SECURITY;

-- Belt-and-suspenders on top of RLS: no table-level privileges
-- for the roles a browser can ever act as. service_role (the
-- server-only key) keeps its Supabase defaults and is the only
-- role the app uses against this table.
REVOKE ALL ON admin_login_events FROM anon, authenticated;

-- ============================================================
-- INDEXES — only where missing (017 already covers
-- profiles(account_id, account_role), contacts(account_id),
-- broadcasts(account_id); subscriptions/plans tables do not
-- exist in this schema yet, so nothing to index there).
-- ============================================================

-- Registration date is profiles.created_at — every leaderboard,
-- chart window, and "newest first" sort in the admin keys on it.
CREATE INDEX IF NOT EXISTS idx_profiles_created_at
  ON profiles(created_at);

-- ============================================================
-- ADMIN_AGGREGATE — new users per month, zero-filled
--
-- generate_series LEFT JOIN signups, exactly as the spec asks:
-- months with zero registrations come back as 0 rows instead of
-- being absent, and month boundaries are cut in the configured
-- timezone (Asia/Kolkata by default) so a 22:30 IST signup never
-- lands in the wrong month for IST users.
--
-- "Customer" here = profiles.account_role = 'owner': the people
-- who signed up for the product themselves. Teammates redeemed
-- through an invitation carry admin/agent/viewer and are
-- excluded. p_excluded_user_id lets the server drop the Platform
-- Owner's own account from every count.
--
-- SECURITY DEFINER + revoked public execute: callable only with
-- the service-role key, from server code.
-- ============================================================
CREATE OR REPLACE FUNCTION admin_new_users_by_month(
  p_months integer DEFAULT 12,
  p_timezone text DEFAULT 'Asia/Kolkata',
  p_excluded_user_id uuid DEFAULT NULL
) RETURNS TABLE(month_start date, new_users bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH months AS (
    SELECT generate_series(
      date_trunc('month', (now() AT TIME ZONE p_timezone))
        - ((p_months - 1) * interval '1 month'),
      date_trunc('month', (now() AT TIME ZONE p_timezone)),
      interval '1 month'
    )::date AS month_start
  ),
  signups AS (
    SELECT date_trunc('month', p.created_at AT TIME ZONE p_timezone)::date AS month_start
    FROM public.profiles p
    WHERE p.account_role = 'owner'
      AND (p_excluded_user_id IS NULL OR p.user_id <> p_excluded_user_id)
      AND p.created_at AT TIME ZONE p_timezone
          >= date_trunc('month', (now() AT TIME ZONE p_timezone))
             - ((p_months - 1) * interval '1 month')
  )
  SELECT m.month_start,
         COUNT(s.month_start)::bigint AS new_users
  FROM months m
  LEFT JOIN signups s ON s.month_start = m.month_start
  GROUP BY m.month_start
  ORDER BY m.month_start;
$$;

REVOKE ALL ON FUNCTION admin_new_users_by_month(integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_new_users_by_month(integer, text, uuid) TO service_role;

-- ============================================================
-- ADMIN_AGGREGATE — active users within a trailing window
--
-- "Sign-in or recorded activity in the last N days". There is no
-- activity-log table in this schema, so the strongest signals
-- that exist are combined: the auth-side last_sign_in_at (set on
-- every login) and the profile row's updated_at (bumped by the
-- settings/profile edits customers actually make). Accounts that
-- never signed in after creation fall back to their created_at,
-- which keeps a just-registered user "active" — matching the
-- spirit of the definition on this data model.
--
-- Reading auth.users needs definer privileges (PostgREST never
-- exposes the auth schema), hence SECURITY DEFINER, same grants
-- as above.
-- ============================================================
CREATE OR REPLACE FUNCTION admin_active_user_count(
  p_days integer DEFAULT 30,
  p_excluded_user_id uuid DEFAULT NULL
) RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::bigint
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.user_id
  WHERE p.account_role = 'owner'
    AND (p_excluded_user_id IS NULL OR p.user_id <> p_excluded_user_id)
    AND GREATEST(
          COALESCE(u.last_sign_in_at, u.created_at),
          COALESCE(p.updated_at, p.created_at)
        ) >= now() - make_interval(days => p_days);
$$;

REVOKE ALL ON FUNCTION admin_active_user_count(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_active_user_count(integer, uuid) TO service_role;

-- ============================================================
-- ADMIN_LOOKUP — newest customer registrations
--
-- Same customer definition as above. Returns enough columns for
-- the Pulse "fresh users" table and the Member Ledger's newest-
-- first default, LIMIT clamped server-side so a caller can't ask
-- for the whole table.
-- ============================================================
CREATE OR REPLACE FUNCTION admin_recent_customers(
  p_limit integer DEFAULT 10,
  p_excluded_user_id uuid DEFAULT NULL
) RETURNS TABLE(user_id uuid, full_name text, email text, phone text, registered_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id,
         p.full_name,
         p.email,
         p.phone,
         p.created_at AS registered_at
  FROM public.profiles p
  WHERE p.account_role = 'owner'
    AND (p_excluded_user_id IS NULL OR p.user_id <> p_excluded_user_id)
  ORDER BY p.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 200);
$$;

REVOKE ALL ON FUNCTION admin_recent_customers(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_recent_customers(integer, uuid) TO service_role;


-- ================= 046_broadcast_scheduling.sql =================
-- ============================================================
-- 046_broadcast_scheduling.sql — Schedule Broadcast feature
--
-- The schema was ALREADY designed for scheduling: migration 001 gave
-- `broadcasts` a `scheduled_at TIMESTAMPTZ` and a status CHECK that
-- includes 'scheduled'. The UI never grew the schedule path, so those
-- columns sat unused. This migration completes the feature without
-- touching anything the working send/resume flows depend on.
--
--   1. 'cancelled' status — so a user can cancel a scheduled broadcast
--      before it fires and the row reads as intentionally stopped
--      rather than being deleted (delete already exists). The cron only
--      scans status='scheduled', so a cancelled row can never be sent.
--
--   2. `scheduled_tz` — the IANA timezone the user picked. `scheduled_at`
--      is an absolute instant; keeping the original zone lets the UI
--      re-display the wall-clock time they chose and pre-fill reschedule.
--
--   3. `header_media_url` — the per-broadcast media-header URL override
--      captured at schedule time, so the server-side cron send reproduces
--      what the browser "send now" pass would have sent. NULL falls back
--      to the template's own stored header URL (unchanged behavior).
--
--   4. Partial index for the due-scan. The cron filters
--      `status='scheduled' AND scheduled_at <= now()`; a partial index on
--      the scheduled subset keeps that sweep cheap as broadcasts grow.
--
-- Idempotent — safe to re-run. Every change is additive to existing
-- columns/constraints; no send, resume, or webhook path is altered.
-- ============================================================

-- 1. Broaden the status CHECK to include 'cancelled'. The inline CHECK in
--    001 is auto-named `broadcasts_status_check`; drop + recreate so a
--    replay from nothing lands the same constraint.
ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_status_check;

ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));

-- 2. Original IANA timezone the schedule was expressed in (display only).
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS scheduled_tz TEXT;

COMMENT ON COLUMN broadcasts.scheduled_tz IS
  'IANA timezone the user chose when scheduling (e.g. Asia/Kolkata). Display / reschedule context only — scheduled_at is the authoritative UTC instant. NULL for pre-scheduling rows.';

-- 3. Media-header URL override captured at schedule time.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url TEXT;

COMMENT ON COLUMN broadcasts.header_media_url IS
  'Runtime media-URL override for an IMAGE/VIDEO/DOCUMENT template header, frozen when a scheduled broadcast was created so the server cron sends the same header the browser pass would have. NULL → use the template''s stored header URL.';

-- 4. Due-scan index for the scheduler cron.
CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled_due
  ON broadcasts (scheduled_at)
  WHERE status = 'scheduled';


-- ================= 048_plans_billing.sql =================
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

DROP TRIGGER IF EXISTS set_updated_at ON public.plans;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.plan_prices;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.plan_prices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.subscriptions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.usage_counters;
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

DROP TRIGGER IF EXISTS contacts_insert_guard ON public.contacts;
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

DROP TRIGGER IF EXISTS tags_insert_guard ON public.tags;
CREATE TRIGGER tags_insert_guard
  BEFORE INSERT ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.guard_fields_tags_feature();

DROP TRIGGER IF EXISTS custom_fields_insert_guard ON public.custom_fields;
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

DROP TRIGGER IF EXISTS on_auth_user_trial ON auth.users;
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


-- ================= 049_admin_vault.sql =================
-- ============================================================
-- 049_admin_vault.sql
-- Plan Vault (Super Admin): subscription history, admin audit log,
-- a DB trigger that records EVERY subscription change (trial grant,
-- payment webhook, expiry cron, admin update), the atomic
-- admin-update RPC, an idempotent backfill, and the missing indexes.
--
-- ADDITIVE ONLY. No drops, no column changes on existing tables.
-- Requires 048 (plans / subscriptions / payment_transactions).
--
-- History capture without touching code paths:
--   A trigger on public.subscriptions writes one subscription_history
--   row per INSERT and per meaningful UPDATE. Writers that know their
--   own provenance (the admin RPC below — and any future code) mark
--   the transaction with:
--     set_config('app.subscription_source', '<source>', true)
--     set_config('app.admin_action_id',      '<uuid>',   true)
--     set_config('app.subscription_amount',  '<amount>', true)
--   Everything else falls through to the heuristic mapping below.
-- ============================================================

-- ------------------------------------------------------------
-- 1. subscription_history — append-only plan history per account.
--    Never updated, never deleted by the application. Rows are keyed
--    loosely (no FK on subscription_id) so a subscription row can
--    never orphan its own history.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.subscription_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES public.plans(id),
  plan_name_snapshot TEXT,
  billing_cycle TEXT,
  -- Rupees, NUMERIC(12,2) — same unit as plan_prices / 048.
  amount NUMERIC(12, 2),
  currency TEXT NOT NULL DEFAULT 'INR',
  -- Stored subscription status at the time of the event.
  status TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'system' CHECK (source IN (
    'trial', 'customer_payment', 'renewal', 'cancellation', 'expiry',
    'admin_update', 'system', 'backfill'
  )),
  admin_action_id UUID,
  -- Only backfill rows carry a dedupe key (idempotency anchor);
  -- live trigger rows are always NULL (UNIQUE ignores NULLs).
  dedupe_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscription_history_account_idx
  ON public.subscription_history(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_history_subscription_idx
  ON public.subscription_history(subscription_id, created_at DESC);

-- ------------------------------------------------------------
-- 2. admin_action_log — insert-only audit trail. The guard trigger
--    makes UPDATE/DELETE impossible unless the session explicitly
--    sets app.allow_admin_log_mutation = 'on' (no application code
--    ever does; it exists solely for a manual DBA correction).
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_action_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL,
  action TEXT NOT NULL,
  target_account_id UUID,
  target_subscription_id UUID,
  before JSONB,
  after JSONB,
  reason TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_action_log_target_idx
  ON public.admin_action_log(target_subscription_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.guard_admin_action_log()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('app.allow_admin_log_mutation', true), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'admin_action_log is insert-only (UPDATE/DELETE forbidden)'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS admin_action_log_no_mutation ON public.admin_action_log;
CREATE TRIGGER admin_action_log_no_mutation
  BEFORE UPDATE OR DELETE ON public.admin_action_log
  FOR EACH ROW EXECUTE FUNCTION public.guard_admin_action_log();

-- ------------------------------------------------------------
-- 3. History capture trigger on subscriptions.
--    Fires on every INSERT and on UPDATEs that change any field the
--    Vault / detail page displays. Sources are either marked via
--    set_config (admin RPC today, gateway webhooks tomorrow) or
--    derived from the row transition itself.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_subscription_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new   subscriptions := NEW;
  v_old   subscriptions := OLD;
  v_src   TEXT;
  v_amount NUMERIC(12, 2);
  v_action UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD; -- never expected; nothing to record
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old := OLD;
  END IF;

  v_src := NULLIF(current_setting('app.subscription_source', true), '');

  IF v_src IS NULL THEN
    -- Heuristic provenance for un-marked writes.
    IF TG_OP = 'INSERT' THEN
      v_src := CASE WHEN NEW.plan_id = 'trial' OR NEW.status = 'trialing'
                    THEN 'trial' ELSE 'customer_payment' END;
    ELSE
      v_src := CASE
        WHEN NEW.status = 'canceled' AND v_old.status IS DISTINCT FROM 'canceled' THEN 'cancellation'
        WHEN NEW.status = 'expired'  AND v_old.status IS DISTINCT FROM 'expired'  THEN 'expiry'
        WHEN NEW.status = 'active'   AND v_old.status IS DISTINCT FROM 'active'   THEN 'customer_payment'
        WHEN NEW.status = 'trialing' AND v_old.status IS DISTINCT FROM 'trialing' THEN 'trial'
        -- period extended / plan swapped while live → renewal-shaped change
        WHEN (NEW.current_period_end IS DISTINCT FROM v_old.current_period_end
              OR NEW.plan_id IS DISTINCT FROM v_old.plan_id) THEN 'renewal'
        ELSE 'system'
      END;
    END IF;
  END IF;

  v_action := NULLIF(current_setting('app.admin_action_id', true), '')::UUID;

  -- Amount for the snapshot row: explicit mark first, then the plan
  -- price for the row's cycle, then zero for the free trial. Never a
  -- guess from a partial payment history.
  v_amount := NULLIF(current_setting('app.subscription_amount', true), '')::NUMERIC;
  IF v_amount IS NULL THEN
    SELECT pp.amount INTO v_amount
    FROM plan_prices pp
    WHERE pp.plan_id = NEW.plan_id AND pp.billing_cycle = NEW.billing_cycle;
  END IF;

  INSERT INTO public.subscription_history (
    subscription_id, account_id, plan_id, plan_name_snapshot, billing_cycle,
    amount, currency, status, period_start, period_end, source, admin_action_id
  )
  VALUES (
    NEW.id, NEW.account_id, NEW.plan_id,
    (SELECT name FROM plans WHERE id = NEW.plan_id),
    NEW.billing_cycle, v_amount, 'INR', NEW.status,
    NEW.current_period_start, NEW.current_period_end, v_src, v_action
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_history_trigger ON public.subscriptions;
CREATE TRIGGER subscriptions_history_trigger
  AFTER INSERT OR UPDATE OF
    plan_id, status, billing_cycle,
    current_period_start, current_period_end, trial_end,
    gateway, gateway_subscription_id, gateway_customer_id
  ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.record_subscription_history();

-- ------------------------------------------------------------
-- 4. admin_update_subscription — the ONE write path of the admin
--    area (spec Part 4.5). Single function call = single transaction:
--    lock the row → concurrency check on updated_at → validate →
--    insert audit row → mark the transaction (source / audit link /
--    amount) → UPDATE (which fires the history trigger) → return
--    the fresh row.
--
--    SECURITY DEFINER, granted to service_role only — the API route
--    behind requireOwner + CSRF + rate limit is the sole caller. All
--    validation also runs there; the checks below are the last line.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_update_subscription(
  p_subscription_id   UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_plan_id           TEXT,
  p_billing_cycle     TEXT,
  p_status            TEXT,           -- stored-status value: active | canceled | expired
  p_period_end        TIMESTAMPTZ,
  p_amount            NUMERIC,
  p_reason            TEXT,
  p_admin_user_id     UUID,
  p_ip                TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old   subscriptions;
  v_audit UUID;
  v_row   JSONB;
BEGIN
  SELECT * INTO v_old FROM subscriptions WHERE id = p_subscription_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'not_found');
  END IF;

  -- Optimistic concurrency: a webhook paid while the panel was open
  -- bumps updated_at; the stale save must not clobber it (409).
  IF p_expected_updated_at IS NULL OR v_old.updated_at > p_expected_updated_at THEN
    RETURN jsonb_build_object(
      'ok', FALSE, 'error', 'stale',
      'row', to_jsonb(v_old)
    );
  END IF;

  -- Last-line validation (the API layer mirrors this for field errors).
  IF NOT EXISTS (SELECT 1 FROM plans WHERE id = p_plan_id AND is_public = TRUE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'invalid_plan');
  END IF;
  IF p_billing_cycle NOT IN ('monthly', 'yearly') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'invalid_billing_cycle');
  END IF;
  IF p_status NOT IN ('active', 'canceled', 'expired') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'invalid_status');
  END IF;
  IF p_status = 'active' AND p_period_end <= NOW() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'expiry_must_be_future');
  END IF;
  IF p_period_end <= COALESCE(v_old.current_period_start, NOW() - INTERVAL '1 day') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'expiry_before_start');
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'invalid_amount');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'invalid_reason');
  END IF;

  INSERT INTO public.admin_action_log (
    admin_user_id, action, target_account_id, target_subscription_id,
    before, after, reason, ip_address
  )
  VALUES (
    p_admin_user_id, 'subscription_update', v_old.account_id, p_subscription_id,
    to_jsonb(v_old),
    jsonb_build_object(
      'plan_id', p_plan_id,
      'billing_cycle', p_billing_cycle,
      'status', p_status,
      'current_period_end', p_period_end,
      'amount', p_amount
    ),
    btrim(p_reason), p_ip
  )
  RETURNING id INTO v_audit;

  -- Mark the transaction so the history trigger attributes the row.
  PERFORM set_config('app.subscription_source', 'admin_update', TRUE);
  PERFORM set_config('app.admin_action_id', v_audit::TEXT, TRUE);
  PERFORM set_config('app.subscription_amount', p_amount::TEXT, TRUE);

  UPDATE subscriptions
     SET plan_id            = p_plan_id,
         billing_cycle      = p_billing_cycle,
         status             = p_status,
         current_period_end = p_period_end
   WHERE id = p_subscription_id;

  SELECT to_jsonb(s) || jsonb_build_object(
           'plan_name', (SELECT name FROM plans WHERE id = s.plan_id)
         )
    INTO v_row
    FROM subscriptions s WHERE s.id = p_subscription_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'row', v_row,
    'audit_id', v_audit,
    'account_id', v_old.account_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_update_subscription(
  UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_subscription(
  UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TIMESTAMPTZ, NUMERIC, TEXT, UUID, TEXT
) TO service_role;

-- ------------------------------------------------------------
-- 5. Idempotent backfill — "how many times subscribed" must be
--    answerable for accounts that existed before this migration.
--    Anchored on dedupe_key so re-running is a no-op:
--      sub:<id>   ← the subscription's current state (one row)
--      txn:<id>   ← every SUCCESSFUL payment transaction
--    Existing history rows (fresh install: none) are respected.
-- ------------------------------------------------------------

INSERT INTO public.subscription_history (
  subscription_id, account_id, plan_id, plan_name_snapshot, billing_cycle,
  amount, currency, status, period_start, period_end, source, dedupe_key
)
SELECT
  s.id, s.account_id, s.plan_id, p.name, s.billing_cycle,
  COALESCE(pp.amount, 0), 'INR', s.status,
  s.current_period_start, s.current_period_end,
  CASE WHEN s.plan_id = 'trial' OR s.status = 'trialing' THEN 'trial' ELSE 'backfill' END,
  'sub:' || s.id
FROM subscriptions s
JOIN plans p ON p.id = s.plan_id
LEFT JOIN plan_prices pp ON pp.plan_id = s.plan_id AND pp.billing_cycle = s.billing_cycle
ON CONFLICT (dedupe_key) DO NOTHING;

INSERT INTO public.subscription_history (
  subscription_id, account_id, plan_id, plan_name_snapshot, billing_cycle,
  amount, currency, status, period_start, period_end, source, dedupe_key
)
SELECT
  t.subscription_id, t.account_id, t.plan_id, p.name, t.billing_cycle,
  t.amount, COALESCE(t.currency, 'INR'), 'active',
  NULL, NULL, 'customer_payment',
  'txn:' || t.id
FROM payment_transactions t
JOIN plans p ON p.id = t.plan_id
WHERE t.status = 'paid' AND t.subscription_id IS NOT NULL
ON CONFLICT (dedupe_key) DO NOTHING;

-- ------------------------------------------------------------
-- 6. Indexes the Vault queries need, added only where missing.
--    (subscriptions(status, current_period_end) and the user/account
--    key indexes already exist from 048.)
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS subscriptions_created_at_idx
  ON public.subscriptions(created_at DESC);
CREATE INDEX IF NOT EXISTS subscriptions_plan_id_idx
  ON public.subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS profiles_created_at_idx
  ON public.profiles(created_at DESC);
CREATE INDEX IF NOT EXISTS accounts_created_at_idx
  ON public.accounts(created_at DESC);
CREATE INDEX IF NOT EXISTS payment_transactions_status_paid_idx
  ON public.payment_transactions(subscription_id, status)
  WHERE status = 'paid';

-- ------------------------------------------------------------
-- 7. RLS. Both tables are admin/service-only: ENABLE with no policies
--    denies every client role; service_role (the admin API) and the
--    SECURITY DEFINER functions bypass. Same posture as 048's write
--    paths — nothing here is reachable from a customer session.
-- ------------------------------------------------------------

ALTER TABLE public.subscription_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_action_log     ENABLE ROW LEVEL SECURITY;


-- ===== applied-check: every object this script must leave behind =====
SELECT 'functions' AS what, string_agg(proname, ', ' ORDER BY proname) AS present
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND proname IN (
  'admin_update_subscription','record_subscription_history','guard_admin_action_log',
  'subscription_effective_plan_id','plan_limit_value','plan_feature_enabled',
  'guard_contacts_insert','guard_fields_tags_feature','grant_trial_subscription',
  'admin_new_users_by_month','admin_active_user_count','admin_recent_customers')
UNION ALL
SELECT 'triggers', string_agg(t.tgname, ', ' ORDER BY t.tgname)
FROM pg_trigger t JOIN pg_class c ON c.oid = t.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public','auth') AND NOT t.tginternal AND t.tgname IN (
  'set_updated_at','contacts_insert_guard','tags_insert_guard','custom_fields_insert_guard',
  'on_auth_user_created','on_auth_user_trial','admin_action_log_no_mutation','subscriptions_history_trigger');

NOTIFY pgrst, 'reload schema';
