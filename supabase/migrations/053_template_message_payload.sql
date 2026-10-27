-- ============================================================
-- 053_template_message_payload
--
-- An outbound template used to be stored as `content_text` = the
-- substituted BODY ONLY, plus `template_name`. The Inbox therefore
-- rendered a delivered template as a plain text bubble: no header
-- (text, image, video or document), no footer, no buttons — the agent
-- could not see what the customer saw, and a body written with WhatsApp
-- markup (`*bold*`, `_italic_`) showed its raw asterisks.
--
-- Reading `message_templates` at render time is not a fix: those columns
-- describe the template as it exists TODAY, so a later edit would
-- silently rewrite history and a deleted template would render nothing.
-- The only faithful record is a snapshot taken at the moment of the
-- send, which is what this column stores.
--
--   `messages.template_payload` — JSONB written ONLY on outbound
--   `content_type = 'template'` rows, shaped by
--   `src/lib/whatsapp/template-render.ts` (`TemplateMessagePayload`):
--     { name, language, category,
--       header: { kind: text|image|video|document, text, mediaUrl, mediaId, filename },
--       body:    the text with every {{n}} already replaced,
--       footer,
--       buttons: [ { type, text, url | phoneNumber | code } ] }
--
-- Nullable, unvalidated at the DB level and deliberately NOT a foreign
-- key or a join: the snapshot must survive the template being edited,
-- re-synced or deleted, and the reader (`parseTemplatePayload`) treats
-- an unexpected shape as "no snapshot" rather than throwing, so the
-- thread keeps rendering text bubbles no matter what is in here.
--
-- No backfill is possible — the header, footer and button labels of a
-- historical send were never stored anywhere. Those rows fall back to a
-- reconstruction from the live template (best effort) and then to the
-- plain text bubble, exactly as they render today.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS template_payload JSONB;

COMMENT ON COLUMN messages.template_payload IS
  'Complete snapshot of an outbound WhatsApp template as delivered: '
  'header (text or media), substituted body, footer and every button. '
  'NULL for every non-template message, for rows written before this '
  'migration, and for sends whose local template row could not be '
  'resolved. Read by the inbox bubble; see migration 053 and '
  'src/lib/whatsapp/template-render.ts.';
