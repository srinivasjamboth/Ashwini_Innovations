-- ============================================================
-- 054_billing_orders.sql
-- Razorpay ORDERS checkout: one local record per checkout attempt
-- (`payment_orders`) and a de-duplication ledger for the public
-- webhook (`razorpay_webhook_events`).
--
-- ADDITIVE ONLY. No drops, no column changes on any existing table,
-- no rewrite of existing customer rows. Safe to run on a database that
-- already has 048/049/052 applied, and idempotent (re-running is a
-- no-op) so it can be pasted into the SQL Editor as many times as
-- needed.
--
-- Requires 048_plans_billing.sql (accounts, plans, subscriptions,
-- payment_transactions, update_updated_at_column()).
--
-- Unit decision (spec PART 2 + the "use rupees" choice): `amount` is
-- stored in RUPEES as NUMERIC(12,2) — the EXACT same unit and column
-- type as plan_prices / payment_transactions / subscription_history.
-- Paise (x100) exist only for one frame at the Razorpay API boundary;
-- nothing in the database is ever a float.
-- ============================================================

-- ------------------------------------------------------------
-- 1. payment_orders — the server-authoritative record of one checkout.
--    Created BEFORE the Razorpay order is opened, updated by verify /
--    webhook / callback / the reconciliation job. Its unique
--    razorpay_payment_id + the payment_transactions unique key together
--    make fulfilment idempotent: two deliveries of the same payment can
--    only ever extend a period once.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payment_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- The member who started the checkout (audit + "own account only"
  -- status lookups). Nullable so a gateway-originated event can never
  -- fail a NOT NULL insert; the account row is the tenant anchor.
  user_id UUID,
  plan_id TEXT REFERENCES public.plans(id),
  -- Snapshot of the plan identity at checkout time, so the billing tab
  -- and the receipt read what the customer actually bought even if the
  -- catalog row is renamed later. Mirrors subscription_history naming.
  plan_name_snapshot TEXT,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  -- RUPEES, NUMERIC(12,2) — same unit as plan_prices / payment_transactions.
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  razorpay_order_id TEXT NOT NULL UNIQUE,
  -- Nullable + UNIQUE: absent until the gateway attaches a payment.
  -- Postgres treats NULLs as distinct, so many unpaid orders coexist.
  razorpay_payment_id TEXT UNIQUE,
  -- Short reconciliation tag handed to Razorpay (kept <40 chars by the
  -- checkout route). Server-side only; never derived from the client.
  receipt TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'attempted', 'paid', 'failed', 'cancelled'
  )),
  payment_method TEXT CHECK (payment_method IN ('upi', 'card', 'netbanking', 'wallet')),
  failure_reason TEXT,
  -- Set exactly once, when the plan was activated from THIS order.
  fulfilled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reuse for the double-click / 10-minute guard and the per-account list.
CREATE INDEX IF NOT EXISTS payment_orders_account_created_idx
  ON public.payment_orders(account_id, created_at DESC);
-- The reconciliation scan: created/attempted orders within a time box.
CREATE INDEX IF NOT EXISTS payment_orders_reconcile_idx
  ON public.payment_orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_orders_status_idx
  ON public.payment_orders(status);

DROP TRIGGER IF EXISTS set_updated_at ON public.payment_orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 2. razorpay_webhook_events — processed-event ledger. The webhook
--    inserts the event id here first; a re-delivery collides on the
--    primary key and is acknowledged without acting again. Separate from
--    payment_orders so an event that carries no order (or arrives out of
--    order) still de-duplicates cleanly.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.razorpay_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 3. RLS. Both tables are service-role only. ENABLE with no policies
--    denies every client role; the service_role key the billing routes
--    use bypasses. Nothing here is reachable from a customer session —
--    reads go through the tenant-scoped API routes. Same posture as
--    048's write paths and 049's vault tables.
-- ------------------------------------------------------------

ALTER TABLE public.payment_orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.razorpay_webhook_events ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
