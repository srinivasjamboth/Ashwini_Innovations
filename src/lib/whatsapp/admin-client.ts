import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for WhatsApp number-catalog work
// (migration 047). Mirrors the per-module pattern used by the
// automations engine and webhook handler. SERVER ONLY — importing
// this from a client component would ship SUPABASE_SERVICE_ROLE_KEY
// to the browser. Every call site lives under server API routes.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
