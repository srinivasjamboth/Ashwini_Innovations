-- ============================================================
-- 056_contact_groups.sql — Contact groups (PART A)
--
-- What this migration does
--   1. `contact_groups` — named, account-scoped groups of contacts
--      (name max 50 chars, unique per account ignoring case;
--      description optional, max 200).
--   2. `contact_group_members` — the many-to-many join with
--      PK (group_id, contact_id) so adding an existing member is a
--      harmless no-op, CASCADE from BOTH sides (deleting a group or a
--      contact only removes membership rows — never the contacts
--      themselves), and an index on contact_id for the
--      "contact is in ANY selected group" filter.
--   3. RLS mirroring the contacts policies (migration 017): every
--      account member can read, agent+ can write. No plan check —
--      groups are a common feature.
--   4. SECURITY INVOKER RPCs (same pattern as 025) so RLS keeps
--      scoping every query to the caller's account while join
--      resolution, de-duplication, live member counts and
--      windowed total counts happen in ONE server round-trip — the
--      client-side 1000-row PostgREST cap must never silently
--      truncate a group.
--
-- Member counts are computed live from the join on every read — no
-- stored counter to go stale.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ── contact_groups ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contact_groups (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 50),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 200),
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Case-insensitive unique name per account (trimmed in the app layer).
CREATE UNIQUE INDEX IF NOT EXISTS contact_groups_account_name_lower_uidx
  ON public.contact_groups (account_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_contact_groups_account
  ON public.contact_groups (account_id);

ALTER TABLE public.contact_groups ENABLE ROW LEVEL SECURITY;

-- Same tenancy shape as `contacts` (017): members read, agents write.
DROP POLICY IF EXISTS contact_groups_select ON public.contact_groups;
DROP POLICY IF EXISTS contact_groups_insert ON public.contact_groups;
DROP POLICY IF EXISTS contact_groups_update ON public.contact_groups;
DROP POLICY IF EXISTS contact_groups_delete ON public.contact_groups;
CREATE POLICY contact_groups_select ON public.contact_groups FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY contact_groups_insert ON public.contact_groups FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY contact_groups_update ON public.contact_groups FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY contact_groups_delete ON public.contact_groups FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- updated_at maintenance, same trigger function as every other table (001).
DROP TRIGGER IF EXISTS set_contact_groups_updated_at ON public.contact_groups;
CREATE TRIGGER set_contact_groups_updated_at
  BEFORE UPDATE ON public.contact_groups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── contact_group_members ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contact_group_members (
  group_id   UUID NOT NULL REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id)   ON DELETE CASCADE,
  added_at   TIMESTAMPTZ DEFAULT NOW(),
  added_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (group_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_group_members_contact
  ON public.contact_group_members (contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_group_members_group
  ON public.contact_group_members (group_id);

-- ── created_by / added_by reference auth.users, not profiles ───
-- Both columns hold the signed-in user's id (`session.user.id`), the
-- convention every other audit column in this schema follows (026
-- api_keys, 028 webhook_endpoints, 029 ai_configs, 030
-- ai_knowledge_documents, 043 whatsapp_flows). `profiles.id` is a
-- surrogate key from uuid_generate_v4() — profiles reaches auth
-- through its own `user_id` column — so an FK to profiles(id)
-- rejected every insert with contact_groups_created_by_fkey.
-- `CREATE TABLE IF NOT EXISTS` cannot restate a column on a table that
-- already exists, so the constraint is dropped and re-declared: a
-- fresh database gets it from the definitions above and this is a
-- no-op replace, while a database that already ran the earlier version
-- self-heals.
ALTER TABLE public.contact_groups
  DROP CONSTRAINT IF EXISTS contact_groups_created_by_fkey;
ALTER TABLE public.contact_group_members
  DROP CONSTRAINT IF EXISTS contact_group_members_added_by_fkey;

-- A value that no longer exists in auth.users would stop the re-added
-- constraint from validating, so clear any such id first.
UPDATE public.contact_groups g SET created_by = NULL
 WHERE g.created_by IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.created_by);
UPDATE public.contact_group_members m SET added_by = NULL
 WHERE m.added_by IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.added_by);

ALTER TABLE public.contact_groups
  ADD CONSTRAINT contact_groups_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.contact_group_members
  ADD CONSTRAINT contact_group_members_added_by_fkey
  FOREIGN KEY (added_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.contact_group_members ENABLE ROW LEVEL SECURITY;

-- A membership row is readable by anyone in the group's account, and
-- both sides of a write must live in a writable account (agent+). The
-- sub-SELECTs run through the contacts/contact_groups RLS above, so a
-- row can never bridge two accounts.
DROP POLICY IF EXISTS contact_group_members_select ON public.contact_group_members;
DROP POLICY IF EXISTS contact_group_members_insert ON public.contact_group_members;
DROP POLICY IF EXISTS contact_group_members_delete ON public.contact_group_members;
CREATE POLICY contact_group_members_select ON public.contact_group_members FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.contact_groups g
      WHERE g.id = contact_group_members.group_id
        AND is_account_member(g.account_id)
    )
  );
CREATE POLICY contact_group_members_insert ON public.contact_group_members FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.contact_groups g
      WHERE g.id = contact_group_members.group_id
        AND is_account_member(g.account_id, 'agent')
    )
    AND EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_group_members.contact_id
        AND is_account_member(c.account_id, 'agent')
    )
  );
CREATE POLICY contact_group_members_delete ON public.contact_group_members FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.contact_groups g
      WHERE g.id = contact_group_members.group_id
        AND is_account_member(g.account_id, 'agent')
    )
  );

-- ── list_contact_groups ───────────────────────────────────────
-- Groups page table: one row per group with the LIVE member count
-- (join, never a stored counter), search, windowed total, pagination.
CREATE OR REPLACE FUNCTION public.list_contact_groups(
  p_search TEXT DEFAULT NULL,
  p_limit  INT  DEFAULT 25,
  p_offset INT  DEFAULT 0
)
RETURNS TABLE (
  id          UUID,
  name        TEXT,
  description TEXT,
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
  SELECT rows.id, rows.name, rows.description, rows.created_by,
         rows.created_at, rows.updated_at, rows.member_count, rows.total_count
  FROM rows
  ORDER BY rows.created_at DESC, rows.id;
$$;

ALTER FUNCTION public.list_contact_groups(TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_contact_groups(TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_contact_groups(TEXT, INT, INT) TO authenticated;

-- ── list_group_members ────────────────────────────────────────
-- Group detail members table: contacts of a group with search,
-- windowed total and pagination — one round-trip, never capped.
CREATE OR REPLACE FUNCTION public.list_group_members(
  p_group_id UUID,
  p_search   TEXT DEFAULT NULL,
  p_limit    INT  DEFAULT 25,
  p_offset   INT  DEFAULT 0
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
    JOIN contact_group_members m ON m.contact_id = c.id
    WHERE m.group_id = p_group_id
      AND (
        p_search IS NULL
        OR c.name  ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
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

ALTER FUNCTION public.list_group_members(UUID, TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_group_members(UUID, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_group_members(UUID, TEXT, INT, INT) TO authenticated;

-- ── filter_contacts_by_groups ─────────────────────────────────
-- The Contacts page "Groups" filter (and the broadcast groups
-- audience): contacts in ANY selected group, optionally narrowed by
-- ANY of the selected tags (each dimension ORs internally, the
-- dimensions AND together), plus the usual search. DISTINCT so a
-- contact in several selected groups counts once — one message per
-- contact even across overlapping groups.
CREATE OR REPLACE FUNCTION public.filter_contacts_by_groups(
  p_group_ids UUID[],
  p_tag_ids   UUID[] DEFAULT NULL,
  p_search    TEXT   DEFAULT NULL,
  p_limit     INT    DEFAULT 25,
  p_offset    INT    DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_group_members m ON m.contact_id = c.id
    WHERE m.group_id = ANY(p_group_ids)
      AND (
        p_tag_ids IS NULL
        OR cardinality(p_tag_ids) = 0
        OR EXISTS (
          SELECT 1 FROM contact_tags ct
          WHERE ct.contact_id = c.id AND ct.tag_id = ANY(p_tag_ids)
        )
      )
      AND (
        p_search IS NULL
        OR c.name  ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
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

ALTER FUNCTION public.filter_contacts_by_groups(UUID[], UUID[], TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_groups(UUID[], UUID[], TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_groups(UUID[], UUID[], TEXT, INT, INT) TO authenticated;

-- ── resolve_group_contact_ids ─────────────────────────────────
-- Paged contact-id resolution for the broadcast audience step: the
-- send path needs EVERY member id (thousands), which the plain
-- client-side select would silently truncate at PostgREST's ~1000
-- row cap. Ordered + windowed so the caller loops until total_count
-- ids are collected; DISTINCT across groups so overlapping selections
-- still yield one entry per contact.
CREATE OR REPLACE FUNCTION public.resolve_group_contact_ids(
  p_group_ids UUID[],
  p_limit     INT DEFAULT 1000,
  p_offset    INT DEFAULT 0
)
RETURNS TABLE (contact_id UUID, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH dedup AS (
    -- GROUP BY (not DISTINCT + window in one step): a window over the
    -- join would count membership rows, not distinct contacts, so a
    -- contact in two selected groups would inflate total_count.
    SELECT m.contact_id
    FROM contact_group_members m
    -- Re-check group tenancy through the RLS-visible table so a
    -- caller can never resolve members of a group it cannot see.
    JOIN contact_groups g ON g.id = m.group_id
    WHERE m.group_id = ANY(p_group_ids)
    GROUP BY m.contact_id
  ),
  page AS (
    SELECT contact_id, count(*) OVER() AS total_count
    FROM dedup
    ORDER BY contact_id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT page.contact_id, page.total_count FROM page ORDER BY page.contact_id;
$$;

ALTER FUNCTION public.resolve_group_contact_ids(UUID[], INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_group_contact_ids(UUID[], INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_group_contact_ids(UUID[], INT, INT) TO authenticated;

-- ── add_group_members ─────────────────────────────────────────
-- Bulk "add members" with either explicit contact ids OR a filter
-- object so "all contacts matching the current filters" is resolved
-- server-side in ONE statement (works across pages and thousands of
-- contacts). ON CONFLICT DO NOTHING keeps re-adding a member a
-- harmless no-op. SECURITY INVOKER: the RLS INSERT policy on
-- contact_group_members still gates every row, and contacts the
-- caller cannot see (wrong account) never match the filter.
CREATE OR REPLACE FUNCTION public.add_group_members(
  p_group_id           UUID,
  p_contact_ids        UUID[] DEFAULT NULL,
  p_filter_group_ids   UUID[] DEFAULT NULL,
  p_filter_tag_ids     UUID[] DEFAULT NULL,
  p_search             TEXT   DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_added INT;
BEGIN
  -- The target group must belong to an account the caller can write
  -- (agent+). Reading it through RLS enforces exactly that.
  IF NOT EXISTS (SELECT 1 FROM contact_groups g WHERE g.id = p_group_id) THEN
    RAISE EXCEPTION 'group not found';
  END IF;

  IF p_contact_ids IS NOT NULL AND cardinality(p_contact_ids) > 0 THEN
    INSERT INTO contact_group_members (group_id, contact_id, added_by)
    SELECT p_group_id, cid, auth.uid()
    FROM unnest(p_contact_ids) AS cid
    ON CONFLICT (group_id, contact_id) DO NOTHING;
    GET DIAGNOSTICS v_added = ROW_COUNT;
  ELSE
    INSERT INTO contact_group_members (group_id, contact_id, added_by)
    SELECT p_group_id, c.id, auth.uid()
    FROM contacts c
    WHERE
      -- "all contacts matching the current filters" — same semantics
      -- as filter_contacts_by_groups: ANY group, ANY tag (both ANDed
      -- across dimensions), plus search. A NULL/empty dimension is
      -- "not restricting".
      (
        p_filter_group_ids IS NULL
        OR cardinality(p_filter_group_ids) = 0
        OR EXISTS (
          SELECT 1 FROM contact_group_members m
          WHERE m.contact_id = c.id AND m.group_id = ANY(p_filter_group_ids)
        )
      )
      AND (
        p_filter_tag_ids IS NULL
        OR cardinality(p_filter_tag_ids) = 0
        OR EXISTS (
          SELECT 1 FROM contact_tags ct
          WHERE ct.contact_id = c.id AND ct.tag_id = ANY(p_filter_tag_ids)
        )
      )
      AND (
        p_search IS NULL
        OR c.name  ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
    ON CONFLICT (group_id, contact_id) DO NOTHING;
    GET DIAGNOSTICS v_added = ROW_COUNT;
  END IF;

  RETURN v_added;
END;
$$;

ALTER FUNCTION public.add_group_members(UUID, UUID[], UUID[], UUID[], TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_group_members(UUID, UUID[], UUID[], UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_group_members(UUID, UUID[], UUID[], UUID[], TEXT) TO authenticated;
