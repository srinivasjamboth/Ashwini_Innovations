-- ============================================================
-- 043_whatsapp_flows.sql — WhatsApp Forms/Flows (Meta Flow registry)
--
-- A local mirror of the Flows this account has published to Meta.
-- "Form" is the customer-facing word (a template button that opens a
-- Flow); `whatsapp_flows` is Meta's object, and the name stays aligned
-- with their API so the mapping is obvious when debugging a rejection.
--
-- Why a local table at all, when Meta owns the Flow?
--   - The Templates builder needs a *published-only* list to populate
--     its Form button dropdown. Meta requires a published Flow for that
--     button to work, so the filter has to live somewhere we control
--     (and re-fetching + filtering Meta's paginated list on every
--     builder keystroke is not acceptable).
--   - Meta's rejection needs to survive a page reload. `status='error'`
--     + `error_message` is what the create panel shows inline instead
--     of a generic failure toast.
--
-- Design notes
--   - Account-scoped, never user-scoped (same as `webhook_endpoints` /
--     `api_keys`). `created_by` is audit only — ON DELETE SET NULL so a
--     departing teammate doesn't orphan the account's Forms.
--   - `meta_flow_id` is nullable on purpose: a row can exist for an
--     attempt Meta rejected. It is never deleted, because a rejected
--     create may still have minted a DRAFT on Meta's side, and losing
--     the id means losing the only handle to clean it up.
--   - `screens_count` is derived from `flow_json` and stored so the
--     list page can render the Screens column without shipping the
--     whole JSON to the browser. Kept in sync by the app layer (the
--     only writer), computed in `parseFlowJson` — a generated column
--     would have to re-implement JSONB array length in SQL for no gain.
--   - `status` is our three-state simplification of Meta's
--     DRAFT/PUBLISHED/DEPRECATED/BLOCKED/THROTTLED. `error` is strictly
--     local (Meta never reports it): it means "our call to Meta failed".
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_flows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  meta_flow_id  text,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'error')),
  flow_json     jsonb NOT NULL,
  screens_count integer NOT NULL DEFAULT 0,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Every list/published query filters by account_id (tenant isolation).
CREATE INDEX IF NOT EXISTS whatsapp_flows_account_id_idx
  ON whatsapp_flows (account_id);

-- The Template Builder's published-only dropdown.
CREATE INDEX IF NOT EXISTS whatsapp_flows_account_status_idx
  ON whatsapp_flows (account_id, status);

-- Meta's id is globally unique; guard against double-inserting the same
-- Flow into one account (partial so the NULL "Meta rejected it" rows
-- stay unconstrained).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_flows_account_meta_flow_id_key
  ON whatsapp_flows (account_id, meta_flow_id)
  WHERE meta_flow_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_flows;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_flows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE whatsapp_flows ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) — agents need the list to
-- read and to pick a Form for a template.
DROP POLICY IF EXISTS whatsapp_flows_select ON whatsapp_flows;
CREATE POLICY whatsapp_flows_select ON whatsapp_flows FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only. Publishing a Flow is an
-- external side effect on the connected WABA that RLS cannot roll back
-- — same class of action as submitting a message template, which the
-- message_templates policies also gate at 'admin'.
DROP POLICY IF EXISTS whatsapp_flows_insert ON whatsapp_flows;
CREATE POLICY whatsapp_flows_insert ON whatsapp_flows FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_flows_update ON whatsapp_flows;
CREATE POLICY whatsapp_flows_update ON whatsapp_flows FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_flows_delete ON whatsapp_flows;
CREATE POLICY whatsapp_flows_delete ON whatsapp_flows FOR DELETE
  USING (is_account_member(account_id, 'admin'));
