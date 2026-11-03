-- ============================================================
-- 057_broadcast_recipient_source.sql — duplicate-preserving
-- broadcast CSV recipients (PART B)
--
-- Behaviour this unlocks
--   Every valid row of a broadcast CSV becomes its OWN recipient row
--   (its own message), even when its number repeats inside the file
--   or matches an existing contact. Group/tag/filter audiences keep
--   sending exactly one message per contact.
--
-- What this migration does
--   1. Adds `source` ('contact' | 'csv', default 'contact' — every
--      pre-existing row was contact-resolved) and `source_row` (the
--      CSV line number the row came from) to broadcast_recipients.
--      Both are purely additive; nothing about the existing columns
--      or the count triggers (003/005/037) changes.
--   2. Adds the uniqueness rules the two audiences need:
--        - CSV rows:   UNIQUE (broadcast_id, source_row) — a retried
--                      importer can never double-insert the SAME row.
--        - Non-CSV:    UNIQUE (broadcast_id, contact_id) — the
--                      one-message-per-contact guarantee for group /
--                      tag / filter / all audiences, now enforced in
--                      the database instead of only app-side.
--      There was NO existing unique rule on (broadcast_id,
--      contact_id) to remove (the app deduped before inserting);
--      these two partial indexes are the whole constraint story.
--
-- Safety: before creating the non-CSV index, existing rows are
-- checked for historical (broadcast_id, contact_id) duplicates. The
-- app-level dedup in use-broadcast-sending has always prevented
-- them, so the check is a guard, not a migration of data — if any
-- legacy row somehow repeats, the migration aborts with an
-- explanatory message instead of a raw 23505.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE public.broadcast_recipients
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'contact'
    CHECK (source IN ('contact', 'csv')),
  ADD COLUMN IF NOT EXISTS source_row INTEGER;

-- CSV rows: one recipient per (broadcast, CSV line).
CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcast_recipients_csv_row
  ON public.broadcast_recipients (broadcast_id, source_row)
  WHERE source = 'csv' AND source_row IS NOT NULL;

-- Non-CSV rows: one recipient per (broadcast, contact). NULL
-- contact_id rows (contact deleted after the send, migration 004)
-- are never compared by a unique index, so history is untouched.
DO $$
DECLARE
  v_dupes BIGINT;
BEGIN
  SELECT count(*) INTO v_dupes
  FROM (
    SELECT broadcast_id, contact_id
    FROM public.broadcast_recipients
    WHERE source <> 'csv' AND contact_id IS NOT NULL
    GROUP BY broadcast_id, contact_id
    HAVING count(*) > 1
  ) d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'broadcast_recipients holds % duplicate (broadcast_id, contact_id) non-CSV rows — de-duplicate them before applying migration 057 (they would violate the new one-message-per-contact index).',
      v_dupes;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'uq_broadcast_recipients_contact'
      AND relnamespace = to_regnamespace('public')
  ) THEN
    CREATE UNIQUE INDEX uq_broadcast_recipients_contact
      ON public.broadcast_recipients (broadcast_id, contact_id)
      WHERE source <> 'csv';
  END IF;
END $$;

-- Campaign-results lookups by row number ("show every row with its
-- row number and status") page the CSV slice of a broadcast.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_source
  ON public.broadcast_recipients (broadcast_id, source, source_row);
