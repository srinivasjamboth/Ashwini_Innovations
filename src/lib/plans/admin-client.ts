import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Service-role client for the plans/billing engine. Mirrors the exact
// per-module pattern already used by automations, flows, ai and whatsapp
// (see their admin-client.ts). SERVER ONLY — importing this from a client
// component would ship SUPABASE_SERVICE_ROLE_KEY to the browser. Every
// call site lives under server API routes / the entitlements service.
let _adminClient: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}
