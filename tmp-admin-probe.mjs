// READ-ONLY probe: do the admin RPCs exist? how much data?
// Run: node tmp-admin-probe.mjs
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('./.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})
const owner = env.ADMIN_OWNER_USER_ID

for (const [fn, args] of [
  ['admin_active_user_count', { p_days: 30, p_excluded_user_id: owner }],
  ['admin_new_users_by_month', { p_months: 12, p_timezone: 'Asia/Kolkata', p_excluded_user_id: owner }],
  ['admin_recent_customers', { p_limit: 10, p_excluded_user_id: owner }],
]) {
  const { error } = await sb.rpc(fn, args)
  console.log(`rpc ${fn}: ${error ? `ERROR ${error.code} ${error.message}` : 'OK'}`)
}

const { count: profilesCount } = await sb
  .from('profiles').select('user_id', { count: 'exact', head: true }).eq('account_role', 'owner')
console.log(`profiles(account_role=owner): ${profilesCount}`)

const { error: evErr } = await sb.from('admin_login_events').select('id', { count: 'exact', head: true })
console.log(`admin_login_events: ${evErr ? `ERROR ${evErr.code} ${evErr.message}` : 'EXISTS'}`)

// Can service_role read auth.users.last_sign_in_at? (needed to replace the active fn)
const { data: au, error: auErr } = await sb.from('profiles').select('user_id, updated_at, created_at').limit(2)
console.log('profiles sample:', JSON.stringify(au), auErr?.message ?? '')
