-- ============================================================
-- 055_automation_graph.sql — Automations graph builder
--
-- Authoring model for the n8n-style automation canvas: a node/edge
-- graph (automation_nodes + automation_edges) that the server
-- compiles into the existing `automation_steps` tree. The engine,
-- cron, pending executions and logs keep reading/writing steps only,
-- so this migration is purely additive for the runtime.
--
-- Idempotent — safe to run multiple times (same conventions as 006
-- and 017: IF NOT EXISTS, DROP POLICY IF EXISTS, guarded constraints).
-- ============================================================

-- ============================================================
-- AUTOMATION_NODES
--
-- `type` holds either the canvas palette (the 15 action types +
-- `starting_step`) or a legacy step type name. Legacy names stay
-- valid so existing step trees decompile 1:1 without config loss.
-- ============================================================
CREATE TABLE IF NOT EXISTS automation_nodes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  -- Tenancy column (mirrors 017): matched by routes and RLS, never
  -- user_id — see the GHSA-xvrq-88hg-44q6 note in the API routes.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    -- canvas entry point (renders automations.trigger_type/config)
    'starting_step',
    -- Messages palette
    'text_button', 'media', 'audio', 'list', 'template',
    'ask_question', 'whatsapp_form', 'payment',
    -- Actions palette
    'save_attribute', 'add_tag', 'google_sheet', 'meta_capi',
    'time_delay', 'webhook', 'condition',
    -- Legacy step types (kept editable / executable)
    'send_message', 'send_buttons', 'send_list', 'send_template',
    'remove_tag', 'assign_conversation', 'update_contact_field',
    'create_deal', 'wait', 'send_webhook', 'close_conversation'
  )),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position_x NUMERIC NOT NULL DEFAULT 0,
  position_y NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_nodes_automation
  ON automation_nodes(automation_id);
CREATE INDEX IF NOT EXISTS idx_automation_nodes_account
  ON automation_nodes(account_id);

ALTER TABLE automation_nodes ENABLE ROW LEVEL SECURITY;

-- Parent-scoped policies, mirroring the 017 automation_steps pattern:
-- reads open to any member, writes require `agent`.
DROP POLICY IF EXISTS automation_nodes_select ON automation_nodes;
CREATE POLICY automation_nodes_select ON automation_nodes FOR SELECT USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_nodes.automation_id AND is_account_member(a.account_id))
);
DROP POLICY IF EXISTS automation_nodes_modify ON automation_nodes;
CREATE POLICY automation_nodes_modify ON automation_nodes FOR ALL USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_nodes.automation_id AND is_account_member(a.account_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_nodes.automation_id AND is_account_member(a.account_id, 'agent'))
);

DROP TRIGGER IF EXISTS set_updated_at ON automation_nodes;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON automation_nodes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- AUTOMATION_EDGES
--
-- `source_handle` distinguishes a Condition node's two output
-- ports ('yes' / 'no'); NULL for every other node type. Edges are
-- created one at a time by the canvas, so created_at is a
-- meaningful sibling order for the graph→steps compiler.
-- ============================================================
CREATE TABLE IF NOT EXISTS automation_edges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_node_id UUID NOT NULL REFERENCES automation_nodes(id) ON DELETE CASCADE,
  target_node_id UUID NOT NULL REFERENCES automation_nodes(id) ON DELETE CASCADE,
  source_handle TEXT CHECK (source_handle IN ('yes', 'no')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_edges_automation
  ON automation_edges(automation_id);
CREATE INDEX IF NOT EXISTS idx_automation_edges_source
  ON automation_edges(source_node_id);
-- One edge per (source, target, handle) triple. NULLS NOT DISTINCT
-- semantics via a COALESCE expression index so it also works on
-- pre-PG15 instances.
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_edges_triple
  ON automation_edges(automation_id, source_node_id, target_node_id, COALESCE(source_handle, ''));

ALTER TABLE automation_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS automation_edges_select ON automation_edges;
CREATE POLICY automation_edges_select ON automation_edges FOR SELECT USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_edges.automation_id AND is_account_member(a.account_id))
);
DROP POLICY IF EXISTS automation_edges_modify ON automation_edges;
CREATE POLICY automation_edges_modify ON automation_edges FOR ALL USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_edges.automation_id AND is_account_member(a.account_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_edges.automation_id AND is_account_member(a.account_id, 'agent'))
);

-- ============================================================
-- AUTOMATION_PENDING_EXECUTIONS.kind
--
-- 'timer'     — existing wait-step rows, drained by the cron when
--               run_at <= now(). Default keeps every pre-existing
--               row (and every existing insert) on the timer path.
-- 'wait_reply'— Ask-a-Question parking rows. NOT time-drained; the
--               inbound webhook resumes them when the contact replies.
-- ============================================================
ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'timer';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_pending_executions_kind_check'
      AND conrelid = 'automation_pending_executions'::regclass
  ) THEN
    ALTER TABLE automation_pending_executions
      ADD CONSTRAINT automation_pending_executions_kind_check
      CHECK (kind IN ('timer', 'wait_reply'));
  END IF;
END $$;

-- Also allow the new engine step types to be expressible on existing
-- rows (automation_steps.step_type is plain TEXT — no constraint to
-- loosen; listed here for the reader: send_media, send_flow,
-- capture_reply join the runtime vocabulary).

-- ============================================================
-- DATA MIGRATION — decompile existing automation_steps trees into
-- nodes + edges so current automations open on the new canvas.
--
-- Mapping (exact inverse of compileGraphToSteps):
--   • one `starting_step` node per automation at (0, 0);
--   • root steps become a sequential chain starting_step → s0 → s1…;
--   • a condition's yes/no child buckets chain out through the
--     matching output handle (first edge carries source_handle,
--     intra-branch edges are plain);
--   • node.type == step.step_type (legacy names pass through 1:1).
--
-- Idempotent: automations that already have nodes are skipped.
-- Edge created_at draws from a migration sequence so sibling order
-- is exactly the walk order and survives a compile round-trip.
-- ============================================================
CREATE SEQUENCE IF NOT EXISTS tmp_graph_edge_order;

-- Decompile one condition bucket: children chain from the condition
-- node through its yes/no handle. Recurses for nested conditions.
CREATE OR REPLACE FUNCTION tmp_graph_decompile_branch(
  p_automation_id UUID,
  p_account_id UUID,
  p_cond_node UUID,
  p_cond_step UUID,
  p_bucket TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  child RECORD;
  prev UUID := p_cond_node;
  handle TEXT := p_bucket;
  base_x NUMERIC;
  base_y NUMERIC;
  nx NUMERIC;
  ny NUMERIC;
  this_node UUID;
BEGIN
  SELECT position_x, position_y INTO base_x, base_y
    FROM automation_nodes WHERE id = p_cond_node;
  nx := base_x + CASE WHEN p_bucket = 'yes' THEN -160 ELSE 160 END;
  ny := base_y + 240;

  FOR child IN
    SELECT id FROM automation_steps
    WHERE automation_id = p_automation_id
      AND parent_step_id = p_cond_step AND branch = p_bucket
    ORDER BY position
  LOOP
    INSERT INTO automation_nodes (automation_id, account_id, type, config, position_x, position_y)
    SELECT p_automation_id, p_account_id, st.step_type, COALESCE(st.step_config, '{}'::jsonb), nx, ny
    FROM automation_steps st WHERE st.id = child.id
    RETURNING id INTO this_node;

    INSERT INTO automation_edges (automation_id, account_id, source_node_id, target_node_id, source_handle, created_at)
    SELECT p_automation_id, p_account_id, prev, this_node, handle,
           '2000-01-01'::timestamptz + (nextval('tmp_graph_edge_order') || ' milliseconds')::interval;

    PERFORM tmp_graph_decompile_branch(p_automation_id, p_account_id, this_node, child.id, 'yes');
    PERFORM tmp_graph_decompile_branch(p_automation_id, p_account_id, this_node, child.id, 'no');

    prev := this_node;
    handle := NULL;
    ny := ny + 240;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION tmp_graph_decompile_all() RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  a RECORD;
  root RECORD;
  this_node UUID;
  prev UUID;
  start_node UUID;
  y NUMERIC;
BEGIN
  FOR a IN
    SELECT am.id, am.account_id FROM automations am
    WHERE NOT EXISTS (SELECT 1 FROM automation_nodes nd WHERE nd.automation_id = am.id)
  LOOP
    INSERT INTO automation_nodes (automation_id, account_id, type, config, position_x, position_y)
    VALUES (a.id, a.account_id, 'starting_step', '{}'::jsonb, 0, 0)
    RETURNING id INTO start_node;

    prev := start_node;
    y := 240;
    FOR root IN
      SELECT id FROM automation_steps
      WHERE automation_id = a.id AND parent_step_id IS NULL
      ORDER BY position
    LOOP
      INSERT INTO automation_nodes (automation_id, account_id, type, config, position_x, position_y)
      SELECT a.id, a.account_id, st.step_type, COALESCE(st.step_config, '{}'::jsonb), 0, y
      FROM automation_steps st WHERE st.id = root.id
      RETURNING id INTO this_node;

      INSERT INTO automation_edges (automation_id, account_id, source_node_id, target_node_id, source_handle, created_at)
      SELECT a.id, a.account_id, prev, this_node, NULL,
             '2000-01-01'::timestamptz + (nextval('tmp_graph_edge_order') || ' milliseconds')::interval;

      PERFORM tmp_graph_decompile_branch(a.id, a.account_id, this_node, root.id, 'yes');
      PERFORM tmp_graph_decompile_branch(a.id, a.account_id, this_node, root.id, 'no');

      prev := this_node;
      y := y + 240;
    END LOOP;
  END LOOP;
END $$;

SELECT tmp_graph_decompile_all();

DROP FUNCTION IF EXISTS tmp_graph_decompile_all();
DROP FUNCTION IF EXISTS tmp_graph_decompile_branch(UUID, UUID, UUID, UUID, TEXT);
DROP SEQUENCE IF EXISTS tmp_graph_edge_order;
