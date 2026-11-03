-- ============================================================
-- 059_carousel_templates
--
-- Meta "media card carousel" templates: one marketing message body
-- followed by 2–10 horizontally scrollable cards, each with an
-- image/video header, optional card text and up to two buttons. They
-- fit none of the existing header columns — a carousel has no single
-- header asset, no footer and no top-level buttons — so the cards are
-- carried in one additive JSONB document and the template's
-- `header_type` is widened with a `carousel` value so every existing
-- reader (badge, preview, send builder, chat bubble) keeps treating a
-- carousel as "not a media header" instead of crashing.
--
--   message_templates.header_type  CHECK widened with 'carousel'
--   message_templates.carousel     the card document (see below)
--   broadcast_recipients.carousel_params
--       per-recipient card values, frozen next to template_params so a
--       server-side Resume rebuilds the exact carousel the operator
--       planned (template_params stays the positional BODY array — the
--       resume path filters it as string[] and must not change).
--   whatsapp_media_ids
--       Meta media-id cache. A carousel send must carry one uploaded
--       asset per CARD, and the same asset is reused by every
--       recipient of a campaign, so the id is stored per
--       (account, phone_number_id, media url) with an expiry instead of
--       being re-uploaded per recipient.
--
-- Carousel JSON shape — written and read only through
-- src/lib/whatsapp/carousel.ts (parseCarousel) and deliberately not
-- validated at the DB level, exactly like messages.template_payload
-- (053): a bad value must degrade to "no cards", never break a thread
-- or a list.
--
--   { media_format: 'image' | 'video',
--     cards_have_text: boolean,
--     button_layout: [ { type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' } ],
--     cards: [ { media_url, media_handle, media_filename, media_size,
--                text, text_examples,
--                buttons: [ { type, text, url, url_example, phone_number } ] } ] }
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. header_type accepts 'carousel'
-- ------------------------------------------------------------
-- The original constraint is auto-named message_templates_header_type_check
-- (001). DROP IF EXISTS covers a database where it was created under a
-- different name by a hand-edit.
ALTER TABLE public.message_templates
  DROP CONSTRAINT IF EXISTS message_templates_header_type_check;

ALTER TABLE public.message_templates
  ADD CONSTRAINT message_templates_header_type_check
  CHECK (header_type IN ('text', 'image', 'video', 'document', 'carousel'));

-- ------------------------------------------------------------
-- 2. The card document
-- ------------------------------------------------------------
ALTER TABLE public.message_templates
  ADD COLUMN IF NOT EXISTS carousel JSONB;

COMMENT ON COLUMN public.message_templates.carousel IS
  'Media card carousel definition (Meta carousel templates): shared media '
  'format, whether cards carry text, the shared button layout and the 2-10 '
  'cards. Set only when header_type = carousel; NULL on every existing row. '
  'Read/written by src/lib/whatsapp/carousel.ts.';

-- A carousel document on a non-carousel template would be silently
-- ignored by every reader, which is worse than refusing it at the door.
ALTER TABLE public.message_templates
  DROP CONSTRAINT IF EXISTS message_templates_carousel_header_check;
ALTER TABLE public.message_templates
  ADD CONSTRAINT message_templates_carousel_header_check
  CHECK (carousel IS NULL OR header_type = 'carousel');

-- ------------------------------------------------------------
-- 3. Per-recipient card values
-- ------------------------------------------------------------
ALTER TABLE public.broadcast_recipients
  ADD COLUMN IF NOT EXISTS carousel_params JSONB;

COMMENT ON COLUMN public.broadcast_recipients.carousel_params IS
  'Frozen per-recipient carousel card values ({ body?, cards: [ { text?, '
  'buttons? } ] }) for a carousel-template broadcast. NULL for every other '
  'template and for rows written before migration 059.';

-- ------------------------------------------------------------
-- 4. Meta media-id cache
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_media_ids (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_number_id text NOT NULL,
  media_url       text NOT NULL,
  media_kind      text NOT NULL CHECK (media_kind IN ('image', 'video', 'document')),
  meta_media_id   text NOT NULL,
  -- Meta expires uploaded media; we re-upload once this passes rather
  -- than trusting an id Meta may have dropped.
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_media_ids_phone_url_unique
    UNIQUE (account_id, phone_number_id, media_url)
);

CREATE INDEX IF NOT EXISTS whatsapp_media_ids_account_id_idx
  ON public.whatsapp_media_ids (account_id);

ALTER TABLE public.whatsapp_media_ids ENABLE ROW LEVEL SECURITY;

-- House convention: reads for any member, writes admin+ (settings-class,
-- mirrors message_templates). The delivery fan-out runs on the
-- service-role client, which bypasses RLS anyway.
DROP POLICY IF EXISTS whatsapp_media_ids_select ON public.whatsapp_media_ids;
CREATE POLICY whatsapp_media_ids_select ON public.whatsapp_media_ids FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_media_ids_all ON public.whatsapp_media_ids;
CREATE POLICY whatsapp_media_ids_all ON public.whatsapp_media_ids FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Re-point a reused asset instead of failing the UNIQUE and forcing a
-- second upload per campaign.
CREATE OR REPLACE FUNCTION public.record_whatsapp_media_id(
  p_account_id      uuid,
  p_phone_number_id text,
  p_media_url       text,
  p_media_kind      text,
  p_meta_media_id   text,
  p_expires_at      timestamptz
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO whatsapp_media_ids
    (account_id, phone_number_id, media_url, media_kind, meta_media_id, expires_at)
  VALUES
    (p_account_id, p_phone_number_id, p_media_url, p_media_kind, p_meta_media_id, p_expires_at)
  ON CONFLICT (account_id, phone_number_id, media_url)
  DO UPDATE SET
    meta_media_id = EXCLUDED.meta_media_id,
    media_kind    = EXCLUDED.media_kind,
    expires_at    = EXCLUDED.expires_at,
    updated_at    = now();
$$;
