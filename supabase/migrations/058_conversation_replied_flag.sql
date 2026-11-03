-- ============================================================
-- 058_conversation_replied_flag.sql — Inbox "Replies" tab
--
-- Semantics: a thread belongs in "Replies" when it is AWAITING a
-- reply from the business side — the most recent message is an
-- inbound (customer) message the agent hasn't answered yet, whether
-- or not the thread has been opened (unread included). Threads the
-- agent/bot answered (or started) drop out. Status (open/pending/
-- closed) is irrelevant, as required.
--
-- What this migration does
--   1. `conversations.awaiting_reply` — boolean mirror of "last
--      message was inbound". Replaces the first-cut `has_agent_reply`
--      ("an agent/bot EVER messaged"): every thread here starts with
--      an outbound (template / broadcast mirror / agent first chat),
--      so that flag was true everywhere and the tab showed the same
--      rows as All — the bug this revision fixes. If the old column
--      exists it is renamed (values recomputed by the backfill
--      below); the obsolete trigger is dropped either way.
--   2. AFTER INSERT trigger on `messages` — messages are written
--      from many code paths (inbox send route, webhook mirror,
--      flows engine, automations engine, AI auto-reply, broadcast
--      chat mirror, public v1 API), so the DB is the only place
--      that can stamp the state completely. Customer INSERT → true;
--      agent/bot INSERT → false. The UPDATE only fires when the row
--      is not already in the target state (WHERE guard), so replies
--      cost at most one conversation UPDATE per direction FLIP —
--      not per message — and a wrong-order double insert still
--      converges (last statement wins is corrected by the guard).
--      The resulting conversations UPDATE rides the existing
--      realtime subscription, so the tab list stays live without
--      refetches.
--   3. SECURITY INVOKER on purpose: viewer-role members can read
--      conversations but their UPDATE policy requires agent+ (017).
--      Outbound message inserts are done by agents (allowed), flows/
--      automations/AI/broadcast/webhook run as service role (bypasses
--      RLS); a viewer insert failing the mirror update is harmless —
--      the row-level INSERT trigger returns NEW and the message
--      itself is never blocked by this flag.
--   4. Backfill — one set-based statement recomputes the state from
--      the actual latest message per thread (handles thousands of
--      conversations in a single scan).
--
-- Deliberately NO index on awaiting_reply: the inbox fetches every
-- conversation once and filters client-side (like the existing
-- status tabs), so an index would only add maintenance to every
-- direction flip without serving any query.
--
-- Idempotent — safe to run multiple times (including after the
-- first-cut version of this file was applied).
-- ============================================================

-- ── rename the first-cut column if it exists, else add fresh ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'conversations'
       AND column_name = 'has_agent_reply'
  ) THEN
    ALTER TABLE public.conversations
      RENAME COLUMN has_agent_reply TO awaiting_reply;
  END IF;
END $$;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS awaiting_reply BOOLEAN NOT NULL DEFAULT false;

-- ── drop the obsolete "ever replied" trigger (its INSERT-time-only
--    stamp can't flip state back, the bug of the first cut) ─────
DROP TRIGGER IF EXISTS on_agent_message ON public.messages;
DROP FUNCTION IF EXISTS public.mark_conversation_replied();

-- ── trigger: mirror the last-message direction onto the thread ──
CREATE OR REPLACE FUNCTION public.mark_conversation_reply_state()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE public.conversations
       SET awaiting_reply = true
     WHERE id = NEW.conversation_id
       AND awaiting_reply IS NOT true;
  ELSIF NEW.sender_type IN ('agent', 'bot') THEN
    UPDATE public.conversations
       SET awaiting_reply = false
     WHERE id = NEW.conversation_id
       AND awaiting_reply IS NOT false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS on_message_reply_state ON public.messages;
CREATE TRIGGER on_message_reply_state
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.mark_conversation_reply_state();

-- ── backfill: recompute from each thread's actual latest message ──
WITH latest AS (
  SELECT DISTINCT ON (m.conversation_id)
         m.conversation_id,
         m.sender_type
    FROM public.messages m
   ORDER BY m.conversation_id, m.created_at DESC, m.id DESC
)
UPDATE public.conversations c
   SET awaiting_reply = (latest.sender_type = 'customer')
  FROM latest
 WHERE c.id = latest.conversation_id
   -- Only rows that actually change — no write, no realtime event,
   -- no updated_at churn for threads already in the right state.
   AND c.awaiting_reply IS DISTINCT FROM (latest.sender_type = 'customer');
