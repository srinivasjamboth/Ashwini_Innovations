-- ============================================================
-- 061_whatsapp_business_id.sql — Meta business portfolio id
--
-- The Settings → WhatsApp "Billing & payments (Meta)" link must open
-- Meta Business Suite's Billing Hub for the CONNECTED account. Billing
-- Hub scopes by portfolio (`?business_id=`), but the connection record
-- only ever stored waba_id + phone_number_id — so the link could only
-- land on whatever portfolio Meta remembered for the browser session.
--
-- Additive and nullable: nothing existing reads this column. It is
-- filled when connecting (POST /api/whatsapp/config) and, for rows that
-- predate this migration, lazily by GET /api/whatsapp/billing-link from
-- GET /{waba_id}?fields=business and cached here, so the Meta call
-- happens at most once per account.
-- ============================================================

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS business_id TEXT;

COMMENT ON COLUMN public.whatsapp_config.business_id IS
  'Meta business portfolio id owning the connected WABA — scopes the Billing Hub deep link. Filled at connect time or lazily from GET /{waba_id}?fields=business; null until first use or when Meta refuses the lookup.';
