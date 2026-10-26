-- ============================================================
-- Super Admin session markers — durable, serverless-safe store.
--
-- WHY THIS EXISTS
-- The admin marker store originally lived in an in-process Map
-- (src/lib/admin/session-store.ts). That is invisible across Vercel's
-- separate serverless functions: login mints a marker in one function's
-- memory, the very next page request runs in a DIFFERENT function whose
-- memory doesn't know the marker, so the owner is bounced back to the
-- login screen forever. Persisting the marker in Postgres gives every
-- function one shared source of truth.
--
-- ISOLATION IS UNCHANGED
-- This table is still reached ONLY by the service-role key (server-side)
-- via the SECURITY DEFINER functions below. It is NOT the shared Supabase
-- auth cookie and never populates one — the opaque admin marker remains
-- the sole admin credential (see "Super Admin Session Isolation").
-- anon/authenticated get nothing: RLS is on with zero policies AND the
-- table privileges + function EXECUTE are revoked for them.
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_session_markers (
  -- Opaque marker token (the ashwini_admin_sid cookie value).
  id           TEXT PRIMARY KEY,
  -- The owner auth uid this marker was minted for. Bound at login; a
  -- presented cookie for any other uid never validates.
  user_id      TEXT NOT NULL,
  -- Owner email captured at mint time (greeting display only — no live
  -- Supabase session is ever read from the admin area).
  email        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_session_markers_last_seen
  ON admin_session_markers(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_admin_session_markers_created
  ON admin_session_markers(created_at);

ALTER TABLE admin_session_markers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_session_markers FROM anon, authenticated;

-- ------------------------------------------------------------
-- admin_session_create — mint a marker for a verified owner login.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_session_create(
  p_id TEXT,
  p_user_id TEXT,
  p_email TEXT
) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO admin_session_markers (id, user_id, email, created_at, last_seen_at)
  VALUES (p_id, p_user_id, p_email, NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;
$$;

-- ------------------------------------------------------------
-- admin_session_resolve — the admin area's single auth primitive.
--
-- Validates the presented marker against the SAME idle/absolute windows
-- the in-memory store used, slides the idle window on success, and
-- returns the bound identity. Returns NULL (and forgets the row) when
-- the marker is unknown, idle-expired, or past the absolute timeout.
-- Also opportunistically sweeps absolutely-expired rows so the table
-- can't grow unbounded. Time comparisons use DB NOW() so every
-- serverless function agrees regardless of container clock skew.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_session_resolve(
  p_id TEXT,
  p_idle_ms BIGINT,
  p_abs_ms BIGINT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
  v_email   TEXT;
BEGIN
  -- Bounded cleanup of fully-absolutely-expired sessions.
  DELETE FROM admin_session_markers
   WHERE (EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000)::BIGINT > p_abs_ms;

  -- Slide + validate in one statement; matched row returns identity.
  UPDATE admin_session_markers
     SET last_seen_at = NOW()
   WHERE id = p_id
     AND (EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000)::BIGINT <= p_abs_ms
     AND (EXTRACT(EPOCH FROM (NOW() - last_seen_at)) * 1000)::BIGINT <= p_idle_ms
  RETURNING user_id, email INTO v_user_id, v_email;

  IF v_user_id IS NULL THEN
    -- Unknown or expired: make sure a stale row can't linger.
    DELETE FROM admin_session_markers WHERE id = p_id;
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object('userId', v_user_id, 'email', v_email);
END;
$$;

-- ------------------------------------------------------------
-- admin_session_revoke — logout / forced eviction.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_session_revoke(p_id TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM admin_session_markers WHERE id = p_id;
$$;

-- Lock EXECUTE down to the service-role key (the only role the app uses
-- against these); the SECURITY DEFINER body is what touches the table.
REVOKE ALL ON FUNCTION admin_session_create(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION admin_session_resolve(TEXT, BIGINT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION admin_session_revoke(TEXT) FROM PUBLIC, anon, authenticated;
