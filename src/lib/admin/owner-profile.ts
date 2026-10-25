/** Shared owner-display-name lookup (greeting in the shell + Pulse). */

import { supabaseAdmin } from './supabase-admin'

/** Profile display name for the owner, with safe fallbacks — used by
 *  the admin shell header and the Pulse greeting. */
export async function getOwnerDisplayName(userId: string, email: string): Promise<string> {
  const fallback = email.split('@')[0] || 'Owner';
  try {
    const { data } = await supabaseAdmin()
      .from('profiles')
      .select('full_name')
      .eq('user_id', userId)
      .maybeSingle();
    const name = data?.full_name?.trim();
    return name && name.length > 0 ? name : fallback;
  } catch {
    return fallback;
  }
}
