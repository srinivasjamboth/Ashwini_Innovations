-- ============================================================
-- 051_broadcast_send_delay
--
-- Per-broadcast pacing: the operator can choose a delay between
-- individual recipient sends so a broadcast never bursts past Meta's
-- upstream messaging rate (HTTP/webhook 130429 "Rate limit hit").
--
-- Default 0 preserves today's behaviour exactly (send-now batches fire
-- with the existing client-side inter-batch pause; server fan-out fires
-- back-to-back). The value is stored on the parent so the scheduled
-- cron, a later Resume, and a Retry-failed pass all pace identically to
-- the send the operator configured.
--
-- Clamped to a sane range (<= 60s/recipient) so a mistyped huge value
-- cannot make a campaign effectively un-completable.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS send_delay_ms INTEGER NOT NULL DEFAULT 0
    CHECK (send_delay_ms >= 0 AND send_delay_ms <= 60000);

COMMENT ON COLUMN broadcasts.send_delay_ms IS
  'Milliseconds to wait between individual recipient sends for this broadcast. 0 = no per-recipient pacing (legacy behaviour).';
