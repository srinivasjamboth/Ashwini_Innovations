-- ============================================================
-- 060_group_folder_color.sql — Groups-tab folders (design spec) +
-- filter-based member adds (PART 3 & PART 4).
--
-- What this migration does
--   1. `contact_groups.color` — nullable palette KEY (additive; every
--      existing group keeps NULL and renders a deterministic default
--      shade from its id in the app). CHECK keeps junk out of the
--      column; the app's isGroupColorKey() is the mirror.
--   2. `list_contact_groups` recreated with the color column (the
--      return SHAPE changes, which CREATE OR REPLACE cannot do — so
--      DROP + re-CREATE; identical body otherwise).
--   3. matched_contact_ids(...) — the ONE matcher every filtered-add
--      path shares. Conditions arrive as a JSONB array of
--      {field, op, value}; the CASE dispatches over a fixed field/
--      op whitelist — no value is ever concatenated into SQL text.
--      SECURITY INVOKER keeps RLS scoping contacts to the account.
--   4. preview / add / chunked-job RPCs on top of the matcher:
--        preview_group_add        — counts behind the live preview
--        match_contacts           — the first-N sample page
--        add_group_members_filtered — one-shot add (Contacts tab
--            "select all N matching" AND small group-detail runs)
--        contact_group_add_jobs + start/run-chunk/get-active —
--            resumable chunked background add for big runs.
--      All ON CONFLICT DO NOTHING: idempotent, never duplicates a
--      member, and re-running a chunk that already landed is a no-op.
--      The job row survives a page refresh; the client resumes from
--      get_active_group_add_job().
--
-- Soft deletes: this schema has no deleted flag on contacts (verified
-- across every migration), so "never add soft-deleted contacts" is
-- satisfied by construction.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ── 1. color column ─────────────────────────────────────────────
ALTER TABLE public.contact_groups
  ADD COLUMN IF NOT EXISTS color TEXT
  CHECK (color IS NULL OR color IN
    ('sea','teal','green','olive','amber','orange','rose','violet','indigo','slate'));

-- ── 2. list_contact_groups with color ───────────────────────────
DROP FUNCTION IF EXISTS public.list_contact_groups(TEXT, INT, INT);
CREATE FUNCTION public.list_contact_groups(
  p_search TEXT DEFAULT NULL,
  p_limit  INT  DEFAULT 25,
  p_offset INT  DEFAULT 0
)
RETURNS TABLE (
  id          UUID,
  name        TEXT,
  description TEXT,
  color       TEXT,
  created_by  UUID,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ,
  member_count BIGINT,
  total_count  BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH rows AS (
    SELECT g.*, count(m.group_id) AS member_count, count(*) OVER () AS total_count
    FROM contact_groups g
    LEFT JOIN contact_group_members m ON m.group_id = g.id
    WHERE (
      p_search IS NULL
      OR g.name ILIKE '%' || p_search || '%'
      OR g.description ILIKE '%' || p_search || '%'
    )
    GROUP BY g.id
    ORDER BY g.created_at DESC, g.id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT rows.id, rows.name, rows.description, rows.color, rows.created_by,
         rows.created_at, rows.updated_at, rows.member_count, rows.total_count
  FROM rows
  ORDER BY rows.created_at DESC, rows.id;
$$;

ALTER FUNCTION public.list_contact_groups(TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_contact_groups(TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_contact_groups(TEXT, INT, INT) TO authenticated;

-- ── 3. matched_contact_ids — the shared matcher ─────────────────
-- Every condition in p_conditions must hold (AND). Unknown fields or
-- ops simply match nothing (ELSE FALSE) — defense in depth behind the
-- app-level sanitizer; uuid/date casts on malformed input raise a
-- plain SQL error, never execute crafted SQL.
CREATE OR REPLACE FUNCTION public.matched_contact_ids(
  p_conditions JSONB DEFAULT '[]'::jsonb,
  p_search     TEXT   DEFAULT NULL
)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH conds AS (
    SELECT x.field, x.op, x.value
    FROM jsonb_to_recordset(COALESCE(p_conditions, '[]'::jsonb))
      AS x(field TEXT, op TEXT, value TEXT)
  )
  SELECT c.id
  FROM contacts c
  WHERE (
    p_search IS NULL
    OR c.name  ILIKE '%' || p_search || '%'
    OR c.phone ILIKE '%' || p_search || '%'
    OR c.email ILIKE '%' || p_search || '%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM conds k WHERE NOT (
      CASE
        -- ── text columns ──
        WHEN k.field = 'name' THEN
          CASE k.op
            WHEN 'eq'         THEN lower(coalesce(c.name,'')) = lower(k.value)
            WHEN 'neq'        THEN lower(coalesce(c.name,'')) <> lower(k.value)
            WHEN 'contains'   THEN coalesce(c.name,'') ILIKE '%' || k.value || '%'
            WHEN 'starts'     THEN coalesce(c.name,'') ILIKE k.value || '%'
            WHEN 'empty'      THEN c.name IS NULL OR btrim(c.name) = ''
            WHEN 'not_empty'  THEN c.name IS NOT NULL AND btrim(c.name) <> ''
            ELSE FALSE
          END
        WHEN k.field = 'phone' THEN
          CASE k.op
            WHEN 'eq'         THEN lower(coalesce(c.phone,'')) = lower(k.value)
            WHEN 'neq'        THEN lower(coalesce(c.phone,'')) <> lower(k.value)
            WHEN 'contains'   THEN coalesce(c.phone,'') ILIKE '%' || k.value || '%'
            WHEN 'starts'     THEN coalesce(c.phone,'') ILIKE k.value || '%'
            WHEN 'empty'      THEN c.phone IS NULL OR btrim(c.phone) = ''
            WHEN 'not_empty'  THEN c.phone IS NOT NULL AND btrim(c.phone) <> ''
            ELSE FALSE
          END
        WHEN k.field = 'email' THEN
          CASE k.op
            WHEN 'eq'         THEN lower(coalesce(c.email,'')) = lower(k.value)
            WHEN 'neq'        THEN lower(coalesce(c.email,'')) <> lower(k.value)
            WHEN 'contains'   THEN coalesce(c.email,'') ILIKE '%' || k.value || '%'
            WHEN 'starts'     THEN coalesce(c.email,'') ILIKE k.value || '%'
            WHEN 'empty'      THEN c.email IS NULL OR btrim(c.email) = ''
            WHEN 'not_empty'  THEN c.email IS NOT NULL AND btrim(c.email) <> ''
            ELSE FALSE
          END
        WHEN k.field = 'company' THEN
          CASE k.op
            WHEN 'eq'         THEN lower(coalesce(c.company,'')) = lower(k.value)
            WHEN 'neq'        THEN lower(coalesce(c.company,'')) <> lower(k.value)
            WHEN 'contains'   THEN coalesce(c.company,'') ILIKE '%' || k.value || '%'
            WHEN 'starts'     THEN coalesce(c.company,'') ILIKE k.value || '%'
            WHEN 'empty'      THEN c.company IS NULL OR btrim(c.company) = ''
            WHEN 'not_empty'  THEN c.company IS NOT NULL AND btrim(c.company) <> ''
            ELSE FALSE
          END
        -- ── tag membership ──
        WHEN k.field = 'tag' THEN
          CASE k.op
            WHEN 'eq'  THEN EXISTS (
              SELECT 1 FROM contact_tags ct
              WHERE ct.contact_id = c.id AND ct.tag_id = k.value::uuid)
            WHEN 'neq' THEN NOT EXISTS (
              SELECT 1 FROM contact_tags ct
              WHERE ct.contact_id = c.id AND ct.tag_id = k.value::uuid)
            WHEN 'in'  THEN EXISTS (
              SELECT 1 FROM contact_tags ct
              WHERE ct.contact_id = c.id
                AND ct.tag_id = ANY(string_to_array(k.value, ',')::uuid[]))
            WHEN 'nin' THEN NOT EXISTS (
              SELECT 1 FROM contact_tags ct
              WHERE ct.contact_id = c.id
                AND ct.tag_id = ANY(string_to_array(k.value, ',')::uuid[]))
            ELSE FALSE
          END
        -- ── member of another group ──
        WHEN k.field = 'group' THEN
          CASE k.op
            WHEN 'eq'  THEN EXISTS (
              SELECT 1 FROM contact_group_members gm
              WHERE gm.contact_id = c.id AND gm.group_id = k.value::uuid)
            WHEN 'neq' THEN NOT EXISTS (
              SELECT 1 FROM contact_group_members gm
              WHERE gm.contact_id = c.id AND gm.group_id = k.value::uuid)
            WHEN 'in'  THEN EXISTS (
              SELECT 1 FROM contact_group_members gm
              WHERE gm.contact_id = c.id
                AND gm.group_id = ANY(string_to_array(k.value, ',')::uuid[]))
            WHEN 'nin' THEN NOT EXISTS (
              SELECT 1 FROM contact_group_members gm
              WHERE gm.contact_id = c.id
                AND gm.group_id = ANY(string_to_array(k.value, ',')::uuid[]))
            ELSE FALSE
          END
        -- ── registered date ──
        WHEN k.field = 'created_at' THEN
          CASE k.op
            WHEN 'eq' THEN
              c.created_at >= k.value::date AND c.created_at < k.value::date + 1
            WHEN 'between' THEN
              c.created_at >= split_part(k.value, ',', 1)::date
              AND c.created_at < split_part(k.value, ',', 2)::date + 1
            ELSE FALSE
          END
        -- ── custom attribute value (stored as TEXT) ──
        WHEN k.field LIKE 'custom:%' THEN
          EXISTS (
            SELECT 1 FROM contact_custom_values cv
            WHERE cv.contact_id = c.id
              AND cv.custom_field_id = split_part(k.field, ':', 2)::uuid
              AND (
                CASE k.op
                  WHEN 'eq'         THEN lower(coalesce(cv.value,'')) = lower(k.value)
                  WHEN 'neq'        THEN lower(coalesce(cv.value,'')) <> lower(k.value)
                  WHEN 'contains'   THEN coalesce(cv.value,'') ILIKE '%' || k.value || '%'
                  WHEN 'starts'     THEN coalesce(cv.value,'') ILIKE k.value || '%'
                  WHEN 'empty'      THEN cv.value IS NULL OR btrim(cv.value) = ''
                  WHEN 'not_empty'  THEN cv.value IS NOT NULL AND btrim(cv.value) <> ''
                  ELSE FALSE
                END
              )
          )
        ELSE FALSE
      END
    )
  );
$$;

ALTER FUNCTION public.matched_contact_ids(JSONB, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.matched_contact_ids(JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.matched_contact_ids(JSONB, TEXT) TO authenticated;

-- ── 4a. match_contacts — sample page for the live preview ───────
CREATE OR REPLACE FUNCTION public.match_contacts(
  p_conditions JSONB DEFAULT '[]'::jsonb,
  p_search     TEXT   DEFAULT NULL,
  p_limit      INT    DEFAULT 5,
  p_offset     INT    DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT c.id, c.created_at
    FROM contacts c
    WHERE c.id IN (SELECT matched_contact_ids(p_conditions, p_search))
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.match_contacts(JSONB, TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.match_contacts(JSONB, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_contacts(JSONB, TEXT, INT, INT) TO authenticated;

-- ── 4b. preview_group_add — the three preview counts ────────────
-- "N contacts match. M are already in this group. K will be added."
-- One round-trip; the group row read enforces the caller can at least
-- see the group (RLS), matching every other group RPC.
CREATE OR REPLACE FUNCTION public.preview_group_add(
  p_group_id   UUID,
  p_conditions JSONB DEFAULT '[]'::jsonb,
  p_search     TEXT   DEFAULT NULL
)
RETURNS TABLE (match_count BIGINT, already_count BIGINT, new_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    count(*)                                                             AS match_count,
    count(*) FILTER (WHERE gm.contact_id IS NOT NULL)                    AS already_count,
    count(*) FILTER (WHERE gm.contact_id IS NULL)                        AS new_count
  FROM matched_contact_ids(p_conditions, p_search) AS mid(id)
  JOIN contact_groups g ON g.id = p_group_id
  LEFT JOIN contact_group_members gm
    ON gm.contact_id = mid.id AND gm.group_id = p_group_id;
$$;

ALTER FUNCTION public.preview_group_add(UUID, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.preview_group_add(UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_group_add(UUID, JSONB, TEXT) TO authenticated;

-- ── 4c. add_group_members_filtered — one-shot filtered add ──────
-- THE shared add endpoint: the group-detail panel (small runs) and
-- the Contacts tab "select all N matching" both call this. Single
-- insert-from-select over the matcher, exclusions skipped, ON
-- CONFLICT DO NOTHING → idempotent across pages and reruns.
CREATE OR REPLACE FUNCTION public.add_group_members_filtered(
  p_group_id   UUID,
  p_conditions JSONB DEFAULT '[]'::jsonb,
  p_search     TEXT   DEFAULT NULL,
  p_excluded   UUID[] DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_added INT;
BEGIN
  -- Reading the group through RLS is exactly the "caller may write
  -- this account" check add_group_members (056) performs.
  IF NOT EXISTS (SELECT 1 FROM contact_groups g WHERE g.id = p_group_id) THEN
    RAISE EXCEPTION 'group not found';
  END IF;

  INSERT INTO contact_group_members (group_id, contact_id, added_by)
  SELECT p_group_id, mid.id, auth.uid()
  FROM matched_contact_ids(p_conditions, p_search) AS mid(id)
  WHERE mid.id <> ALL (COALESCE(p_excluded, '{}')::uuid[])
  ON CONFLICT (group_id, contact_id) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN v_added;
END;
$$;

ALTER FUNCTION public.add_group_members_filtered(UUID, JSONB, TEXT, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_group_members_filtered(UUID, JSONB, TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_group_members_filtered(UUID, JSONB, TEXT, UUID[]) TO authenticated;

-- ── 4d. resumable chunked jobs (runs over 5,000) ────────────────
CREATE TABLE IF NOT EXISTS public.contact_group_add_jobs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id    UUID NOT NULL REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conditions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  search      TEXT,
  excluded    UUID[] NOT NULL DEFAULT '{}',
  added       INT  NOT NULL DEFAULT 0,
  target      BIGINT,
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_add_jobs_group
  ON public.contact_group_add_jobs (group_id);

ALTER TABLE public.contact_group_add_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_group_add_jobs_select ON public.contact_group_add_jobs;
DROP POLICY IF EXISTS contact_group_add_jobs_insert ON public.contact_group_add_jobs;
DROP POLICY IF EXISTS contact_group_add_jobs_update ON public.contact_group_add_jobs;
DROP POLICY IF EXISTS contact_group_add_jobs_delete ON public.contact_group_add_jobs;
CREATE POLICY contact_group_add_jobs_select ON public.contact_group_add_jobs FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY contact_group_add_jobs_insert ON public.contact_group_add_jobs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY contact_group_add_jobs_update ON public.contact_group_add_jobs FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY contact_group_add_jobs_delete ON public.contact_group_add_jobs FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_contact_group_add_jobs_updated_at ON public.contact_group_add_jobs;
CREATE TRIGGER set_contact_group_add_jobs_updated_at
  BEFORE UPDATE ON public.contact_group_add_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- start_group_add_job — snapshot the filter; the job row is what a
-- refreshed page reads back to resume. Housekeeping: a group keeps at
-- most one live job, done jobs are pruned as new ones start.
CREATE OR REPLACE FUNCTION public.start_group_add_job(
  p_group_id   UUID,
  p_conditions JSONB DEFAULT '[]'::jsonb,
  p_search     TEXT   DEFAULT NULL,
  p_excluded   UUID[] DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_account  UUID;
  v_target   BIGINT;
  v_job_id   UUID;
BEGIN
  SELECT account_id INTO v_account FROM contact_groups WHERE id = p_group_id;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'group not found';
  END IF;

  SELECT count(*) INTO v_target
  FROM matched_contact_ids(p_conditions, p_search) AS mid(id)
  WHERE mid.id <> ALL (COALESCE(p_excluded, '{}')::uuid[])
    AND NOT EXISTS (
      SELECT 1 FROM contact_group_members gm
      WHERE gm.group_id = p_group_id AND gm.contact_id = mid.id);

  DELETE FROM contact_group_add_jobs
  WHERE group_id = p_group_id AND status = 'done';

  INSERT INTO contact_group_add_jobs (group_id, account_id, conditions, search, excluded, target)
  VALUES (p_group_id, v_account, COALESCE(p_conditions, '[]'::jsonb), NULLIF(btrim(COALESCE(p_search, '')), ''), COALESCE(p_excluded, '{}'), v_target)
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

ALTER FUNCTION public.start_group_add_job(UUID, JSONB, TEXT, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.start_group_add_job(UUID, JSONB, TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_group_add_job(UUID, JSONB, TEXT, UUID[]) TO authenticated;

-- run_group_add_job_chunk — add up to p_chunk contacts per call.
-- The "still missing" set is re-derived on every call, so progress is
-- idempotent: an interrupted client re-runs the same chunk, already
-- inserted rows fall through ON CONFLICT, and only NEW memberships
-- count. Returns (added, remaining, status) so the caller can show
-- "added X of (X + remaining)" and stop when remaining = 0.
CREATE OR REPLACE FUNCTION public.run_group_add_job_chunk(
  p_job_id UUID,
  p_chunk  INT DEFAULT 2000
)
RETURNS TABLE (added INT, remaining BIGINT, status TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_job      public.contact_group_add_jobs%ROWTYPE;
  v_added    INT := 0;
  v_remaining BIGINT := 0;
BEGIN
  SELECT * INTO v_job FROM contact_group_add_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found';
  END IF;

  IF v_job.status = 'done' THEN
    RETURN QUERY SELECT v_job.added, 0::bigint, v_job.status;
    RETURN;
  END IF;

  INSERT INTO contact_group_members (group_id, contact_id, added_by)
  SELECT v_job.group_id, mid.id, auth.uid()
  FROM matched_contact_ids(v_job.conditions, v_job.search) AS mid(id)
  WHERE mid.id <> ALL (v_job.excluded)
    AND NOT EXISTS (
      SELECT 1 FROM contact_group_members gm
      WHERE gm.group_id = v_job.group_id AND gm.contact_id = mid.id)
  ORDER BY mid.id
  LIMIT p_chunk
  ON CONFLICT (group_id, contact_id) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  SELECT count(*) INTO v_remaining
  FROM matched_contact_ids(v_job.conditions, v_job.search) AS mid(id)
  WHERE mid.id <> ALL (v_job.excluded)
    AND NOT EXISTS (
      SELECT 1 FROM contact_group_members gm
      WHERE gm.group_id = v_job.group_id AND gm.contact_id = mid.id);

  UPDATE contact_group_add_jobs j
  SET added = j.added + v_added,
      status = CASE WHEN v_remaining = 0 THEN 'done' ELSE 'running' END
  WHERE j.id = p_job_id;

  RETURN QUERY SELECT v_added, v_remaining,
    CASE WHEN v_remaining = 0 THEN 'done' ELSE 'running' END::TEXT;
END;
$$;

ALTER FUNCTION public.run_group_add_job_chunk(UUID, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.run_group_add_job_chunk(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_group_add_job_chunk(UUID, INT) TO authenticated;

-- get_active_group_add_job — the resume lookup the group page runs on
-- mount. Only live jobs; the row itself carries everything the chunk
-- RPC needs (conditions/search/excluded live server-side).
CREATE OR REPLACE FUNCTION public.get_active_group_add_job(p_group_id UUID)
RETURNS TABLE (job_id UUID, added INT, target BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT j.id, j.added, j.target
  FROM contact_group_add_jobs j
  WHERE j.group_id = p_group_id AND j.status = 'running'
  ORDER BY j.created_at DESC
  LIMIT 1;
$$;

ALTER FUNCTION public.get_active_group_add_job(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_active_group_add_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_group_add_job(UUID) TO authenticated;
