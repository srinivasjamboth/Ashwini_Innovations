-- ============================================================
-- whatsapp_phone_numbers: every number under a connected WABA
--
-- Both connection paths (Embedded Signup and manual credentials)
-- used to store exactly ONE phone_number_id on whatsapp_config —
-- whichever number the signup session touched, or the one the user
-- pasted. Pre-existing verified numbers under the same WABA were
-- fetched only for validation (listWabaPhoneNumbers in
-- POST /api/whatsapp/config) and never persisted, so the app could
-- never show or switch to them.
--
-- This catalog stores the FULL list Meta returns from
-- GET /{WABA_ID}/phone_numbers per account:
--   * upserted on connect, on "Refresh status", and on demand;
--   * numbers removed on Meta's side are soft-marked (removed_at),
--     never hard-deleted, so message history keyed by the id keeps
--     resolving;
--   * exactly one row per account is is_active — its phone_number_id
--     is what sends use. whatsapp_config.phone_number_id mirrors the
--     active row so no sending code has to change.
--
-- Backfill: each existing whatsapp_config row becomes one active
-- catalog entry, preserving current behavior byte-for-byte.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_phone_numbers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  waba_id TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  display_phone_number TEXT,
  verified_name TEXT,
  -- Raw Meta values, stored verbatim like template status:
  quality_rating TEXT,            -- GREEN | YELLOW | RED | UNKNOWN
  code_verification_status TEXT,  -- VERIFIED | UNVERIFIED | NONE
  platform_type TEXT,
  -- The number this account sends with. At most one active row per
  -- account (partial unique index below).
  is_active BOOLEAN NOT NULL DEFAULT false,
  -- Set when a sync no longer sees the number on Meta's side. Kept
  -- for history; a later sync that finds it again clears this.
  removed_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, phone_number_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_phone_numbers_account
  ON whatsapp_phone_numbers(account_id);

-- One active number per account, enforced at the DB level so a race
-- between two "set active" clicks can't leave the account with zero
-- or two active rows.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_phone_numbers_one_active_per_account
  ON whatsapp_phone_numbers(account_id)
  WHERE is_active;

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_phone_numbers;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON whatsapp_phone_numbers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS — mirror whatsapp_config (settings-class): any member reads,
-- only admins write. Sync itself runs on the service-role client,
-- which bypasses RLS; policies govern the settings UI reads.
ALTER TABLE whatsapp_phone_numbers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_phone_numbers_select ON whatsapp_phone_numbers;
DROP POLICY IF EXISTS whatsapp_phone_numbers_insert ON whatsapp_phone_numbers;
DROP POLICY IF EXISTS whatsapp_phone_numbers_update ON whatsapp_phone_numbers;
DROP POLICY IF EXISTS whatsapp_phone_numbers_delete ON whatsapp_phone_numbers;
CREATE POLICY whatsapp_phone_numbers_select ON whatsapp_phone_numbers FOR SELECT USING (is_account_member(account_id));
CREATE POLICY whatsapp_phone_numbers_insert ON whatsapp_phone_numbers FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_phone_numbers_update ON whatsapp_phone_numbers FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY whatsapp_phone_numbers_delete ON whatsapp_phone_numbers FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- Backfill: adopt the currently configured number as each
-- account's first (active) catalog entry.
-- ------------------------------------------------------------
INSERT INTO whatsapp_phone_numbers (
  account_id,
  waba_id,
  phone_number_id,
  is_active,
  last_synced_at
)
SELECT
  c.account_id,
  -- waba_id is NOT NULL here but nullable on whatsapp_config; an
  -- account connected without one simply isn't backfillable until
  -- the next sync populates it. Skip those rows rather than storing
  -- an empty string that no Meta call would ever match.
  c.waba_id,
  c.phone_number_id,
  true,
  NOW()
FROM whatsapp_config c
WHERE c.waba_id IS NOT NULL AND c.waba_id <> ''
ON CONFLICT (account_id, phone_number_id) DO NOTHING;
