// Temporary probe: what does the LIVE Supabase DB actually hold for plans?
// Run: node tmp-plan-probe.mjs
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

async function get(table, qs) {
  const res = await fetch(`${URL}/rest/v1/${table}?${qs}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 1200) };
}

for (const [table, qs] of [
  ['subscriptions', 'select=account_id,plan_id,status,billing_cycle,trial_end,current_period_end,trial_claimed_at&limit=10'],
  ['plans', 'select=id,name&order=id'],
  ['plan_limits', 'select=plan_id,feature,value,period&limit=40'],
  ['usage_counters', 'select=*&limit=5'],
]) {
  const r = await get(table, qs);
  console.log(`\n=== ${table} [HTTP ${r.status}] ===\n${r.body}`);
}
