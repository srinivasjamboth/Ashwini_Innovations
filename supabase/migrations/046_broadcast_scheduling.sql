-- ============================================================
-- 046_broadcast_scheduling.sql — Schedule Broadcast feature
--
-- The schema was ALREADY designed for scheduling: migration 001 gave
-- `broadcasts` a `scheduled_at TIMESTAMPTZ` and a status CHECK that
-- includes 'scheduled'. The UI never grew the schedule path, so those
-- columns sat unused. This migration completes the feature without
-- touching anything the working send/resume flows depend on.
--
--   1. 'cancelled' status — so a user can cancel a scheduled broadcast
--      before it fires and the row reads as intentionally stopped
--      rather than being deleted (delete already exists). The cron only
--      scans status='scheduled', so a cancelled row can never be sent.
--
--   2. `scheduled_tz` — the IANA timezone the user picked. `scheduled_at`
--      is an absolute instant; keeping the original zone lets the UI
--      re-display the wall-clock time they chose and pre-fill reschedule.
--
--   3. `header_media_url` — the per-broadcast media-header URL override
--      captured at schedule time, so the server-side cron send reproduces
--      what the browser "send now" pass would have sent. NULL falls back
--      to the template's own stored header URL (unchanged behavior).
--
--   4. Partial index for the due-scan. The cron filters
--      `status='scheduled' AND scheduled_at <= now()`; a partial index on
--      the scheduled subset keeps that sweep cheap as broadcasts grow.
--
-- Idempotent — safe to re-run. Every change is additive to existing
-- columns/constraints; no send, resume, or webhook path is altered.
-- ============================================================

-- 1. Broaden the status CHECK to include 'cancelled'. The inline CHECK in
--    001 is auto-named `broadcasts_status_check`; drop + recreate so a
--    replay from nothing lands the same constraint.
ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_status_check;

ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));

-- 2. Original IANA timezone the schedule was expressed in (display only).
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS scheduled_tz TEXT;

COMMENT ON COLUMN broadcasts.scheduled_tz IS
  'IANA timezone the user chose when scheduling (e.g. Asia/Kolkata). Display / reschedule context only — scheduled_at is the authoritative UTC instant. NULL for pre-scheduling rows.';

-- 3. Media-header URL override captured at schedule time.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url TEXT;

COMMENT ON COLUMN broadcasts.header_media_url IS
  'Runtime media-URL override for an IMAGE/VIDEO/DOCUMENT template header, frozen when a scheduled broadcast was created so the server cron sends the same header the browser pass would have. NULL → use the template''s stored header URL.';

-- 4. Due-scan index for the scheduler cron.
CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled_due
  ON broadcasts (scheduled_at)
  WHERE status = 'scheduled';
