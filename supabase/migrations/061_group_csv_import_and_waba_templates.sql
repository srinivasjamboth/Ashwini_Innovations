-- ============================================================
-- 061_group_csv_import_and_waba_templates.sql
--
-- Two fixes:
--   1. Background CSV import into groups & create group from CSV (contact_import_jobs)
--   2. Message templates scoped to currently connected WABA (waba_id column + constraints)
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- PART 1: contact_import_jobs & group CSV import
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.contact_import_jobs (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id            UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  group_id              UUID REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  target_group_id       UUID REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  created_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  file_name             TEXT,
  status                TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  total_rows            INT NOT NULL DEFAULT 0,
  processed_rows        INT NOT NULL DEFAULT 0,
  valid_rows            INT NOT NULL DEFAULT 0,
  new_contacts_count    INT NOT NULL DEFAULT 0,
  existing_added_count  INT NOT NULL DEFAULT 0,
  already_in_group_count INT NOT NULL DEFAULT 0,
  repeats_count         INT NOT NULL DEFAULT 0,
  invalid_count         INT NOT NULL DEFAULT 0,
  invalid_rows          JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message         TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_import_jobs_account
  ON public.contact_import_jobs (account_id);
CREATE INDEX IF NOT EXISTS idx_contact_import_jobs_group
  ON public.contact_import_jobs (group_id);
CREATE INDEX IF NOT EXISTS idx_contact_import_jobs_target_group
  ON public.contact_import_jobs (target_group_id);

ALTER TABLE public.contact_import_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_import_jobs_select ON public.contact_import_jobs;
DROP POLICY IF EXISTS contact_import_jobs_insert ON public.contact_import_jobs;
DROP POLICY IF EXISTS contact_import_jobs_update ON public.contact_import_jobs;
DROP POLICY IF EXISTS contact_import_jobs_delete ON public.contact_import_jobs;

CREATE POLICY contact_import_jobs_select ON public.contact_import_jobs FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY contact_import_jobs_insert ON public.contact_import_jobs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY contact_import_jobs_update ON public.contact_import_jobs FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY contact_import_jobs_delete ON public.contact_import_jobs FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_contact_import_jobs_updated_at ON public.contact_import_jobs;
CREATE TRIGGER set_contact_import_jobs_updated_at
  BEFORE UPDATE ON public.contact_import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Additive columns on existing contact_group_add_jobs to support target_group_id
ALTER TABLE public.contact_group_add_jobs
  ADD COLUMN IF NOT EXISTS target_group_id UUID REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS job_type TEXT DEFAULT 'filter',
  ADD COLUMN IF NOT EXISTS total_rows INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processed_rows INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS new_contacts_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS existing_added_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS already_in_group_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repeats_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invalid_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invalid_rows JSONB DEFAULT '[]'::jsonb;

-- ------------------------------------------------------------
-- PART 2: message_templates scoped to connected WABA
-- ------------------------------------------------------------

-- Add waba_id and removed_at
ALTER TABLE public.message_templates
  ADD COLUMN IF NOT EXISTS waba_id TEXT,
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_message_templates_waba_id
  ON public.message_templates (waba_id)
  WHERE waba_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_templates_removed_at
  ON public.message_templates (removed_at)
  WHERE removed_at IS NOT NULL;

-- Drop legacy unique constraint on (user_id, name, language)
ALTER TABLE public.message_templates
  DROP CONSTRAINT IF EXISTS message_templates_user_name_language_key;
ALTER TABLE public.message_templates
  DROP CONSTRAINT IF EXISTS message_templates_account_name_language_key;
DROP INDEX IF EXISTS message_templates_user_name_language_key;

-- Replace with unique index on (waba_id, name, language) where waba_id is not null
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_waba_name_lang
  ON public.message_templates (waba_id, name, language)
  WHERE waba_id IS NOT NULL;

-- Unique index on (waba_id, meta_template_id) where both are not null
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_waba_meta_id
  ON public.message_templates (waba_id, meta_template_id)
  WHERE waba_id IS NOT NULL AND meta_template_id IS NOT NULL;
