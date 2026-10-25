import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for the Super Admin Dashboard.
// Mirrors src/lib/automations/admin-client.ts — same shape so anyone
// reading either file picks up the convention immediately.
//
// SERVER ONLY. This module reads SUPABASE_SERVICE_ROLE_KEY, which
// bypasses RLS; importing it from a client component ('use client')
// would ship the key to the browser. Every call site here lives
// under lib/admin / server routes and is additionally gated by
// requireOwner().
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
