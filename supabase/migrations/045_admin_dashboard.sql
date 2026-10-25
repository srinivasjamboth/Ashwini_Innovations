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
