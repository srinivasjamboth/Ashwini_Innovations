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
