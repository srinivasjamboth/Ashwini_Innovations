// Throwaway generator: builds supabase/apply_now.sql = 048 + 049 with
// DROP TRIGGER IF EXISTS guards + applied-check + schema-cache reload.
import { readFileSync, writeFileSync } from 'node:fs';

function guard(src) {
  const re = /CREATE TRIGGER (\w+)\s+[\s\S]*?ON\s+(public|auth)\.(\w+)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    out += src.slice(last, m.index);
    out += `DROP TRIGGER IF EXISTS ${m[1]} ON ${m[2]}.${m[3]};\n`;
    out += src.slice(m.index, m.index + m[0].length);
    last = m.index + m[0].length;
  }
  return out + src.slice(last);
}

const files = [
  'supabase/migrations/044_profile_phone.sql',
  'supabase/migrations/045_admin_dashboard.sql',
  'supabase/migrations/046_broadcast_scheduling.sql',
  'supabase/migrations/048_plans_billing.sql',
  'supabase/migrations/049_admin_vault.sql',
];
const a = files.map((f) => `-- ================= ${f.split('/').pop()} =================\n` + guard(readFileSync(f, 'utf8'))).join('\n\n');

const tail = `
-- ===== applied-check: every object this script must leave behind =====
SELECT 'functions' AS what, string_agg(proname, ', ' ORDER BY proname) AS present
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND proname IN (
  'admin_update_subscription','record_subscription_history','guard_admin_action_log',
  'subscription_effective_plan_id','plan_limit_value','plan_feature_enabled',
  'guard_contacts_insert','guard_fields_tags_feature','grant_trial_subscription',
  'admin_new_users_by_month','admin_active_user_count','admin_recent_customers')
UNION ALL
SELECT 'triggers', string_agg(t.tgname, ', ' ORDER BY t.tgname)
FROM pg_trigger t JOIN pg_class c ON c.oid = t.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public','auth') AND NOT t.tginternal AND t.tgname IN (
  'set_updated_at','contacts_insert_guard','tags_insert_guard','custom_fields_insert_guard',
  'on_auth_user_created','on_auth_user_trial','admin_action_log_no_mutation','subscriptions_history_trigger');

NOTIFY pgrst, 'reload schema';
`;

writeFileSync(
  'supabase/apply_now.sql',
  `-- One-time apply for migrations 044 + 045 + 046 + 048 + 049 (safe to re-run on any state).\n${a}\n${tail}`,
);
console.log('written supabase/apply_now.sql, lines:', readFileSync('supabase/apply_now.sql', 'utf8').split('\n').length);
const url = readFileSync('.env.local', 'utf8').match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)?.[1]?.trim();
console.log('project url:', url);
