-- ============================================================
-- 044_profile_phone
--
-- Signup now asks for a phone number alongside name, email and
-- password. The value has to live somewhere the app can read it back
-- per-account, so it lands on `profiles` — the same row the header,
-- the sidebar and the settings form already fetch — rather than only
-- in `auth.users.raw_user_meta_data`, which is invisible to any query
-- that joins profiles for a member list.
--
-- Three changes:
--
--   1. `profiles.phone TEXT` — nullable, with a format CHECK.
--
--      Nullable on purpose. Existing accounts were created before the
--      field existed, and an invited member's profile is bootstrapped
--      by an RPC (019) that never sees a phone. NOT NULL would have
--      broken both paths — and, worse, the invite flow — on the first
--      deploy.
--
--      The CHECK is deliberately narrow: an optional leading `+` and
--      7-15 digits, i.e. E.164 without the separators. The browser
--      normalises input to exactly that shape (src/lib/auth/phone.ts),
--      so the constraint is a guard against a hand-edited API call, not
--      a validator users ever see. Spaces, dashes and parentheses are
--      stripped before the write.
--
--   2. `handle_new_user()` carries `phone` through from the signup
--      metadata, mirroring how it already carries `full_name`. The
--      current definition is migration 017's (personal account + owner
--      role in one transaction), so this is that body with the extra
--      column — nothing else about it changes.
--
--      The metadata value is client-supplied, so it is filtered against
--      the same pattern the CHECK enforces and dropped to NULL when it
--      does not match. Without that, one malformed `phone` in a signup
--      payload would fail the profiles insert, the function's EXCEPTION
--      handler would swallow it, and the user would hold a valid auth
--      account with no profile row — the read-only-session failure
--      mode described in 017 and issue #471.
--
--   3. Nothing on `contacts`. That table's `phone` column (migration
--      001) is a WhatsApp *customer* number on a different account
--      boundary; a member's own phone belongs to the identity, not the
--      CRM record, and conflating them would corrupt both.
--
-- No backfill is possible: phone numbers were never collected before
-- this migration. Existing members add theirs in Settings → Profile.
--
-- Numbered 044 rather than 043: 043_whatsapp_flows.sql already occupies
-- that prefix, and Supabase applies migrations in filename order and
-- refuses two files with the same version number.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS phone TEXT;

-- Drop-then-add so the constraint definition can evolve on a re-run
-- (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_phone_format;
ALTER TABLE profiles ADD CONSTRAINT profiles_phone_format
  CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{7,15}$');

COMMENT ON COLUMN profiles.phone IS
  'Account holder''s own phone number in E.164-ish form: an optional '
  'leading + followed by 7-15 digits, no separators. Collected at '
  'signup, editable in Settings. NULL for accounts created before '
  'migration 044 and for members whose profile was bootstrapped by an '
  'invite. Distinct from contacts.phone, which is a WhatsApp customer '
  'number.';

-- ============================================================
-- handle_new_user(): same as migration 017, plus phone.
-- ============================================================
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_phone TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  -- Client-supplied, so it is only kept when it satisfies the
  -- profiles_phone_format CHECK. See the header: an insert that raises
  -- here would be swallowed by the EXCEPTION block and leave the new
  -- user with no profile row at all.
  v_phone := NEW.raw_user_meta_data->>'phone';
  IF v_phone IS NULL OR v_phone !~ '^\+?[0-9]{7,15}$' THEN
    v_phone := NULL;
  END IF;

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, phone, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_phone, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
