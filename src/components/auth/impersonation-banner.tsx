'use client';

import { useState } from 'react';
import { LogOut, ShieldAlert } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { ADMIN_ROOT } from '@/lib/admin/constants';
import { Button } from '@/components/ui/button';

/**
 * The impersonation banner — the ONLY customer-side UI the Super Admin
 * login-as-user feature adds. The dashboard layout renders it whenever
 * lib/auth/impersonation-state resolves a live admin marker together
 * with a customer session, so it can never be hidden by the app itself
 * and never shows for a genuine customer.
 *
 * Exit ends ONLY the customer session: `signOut({ scope: 'local' })`
 * clears the sb-* cookies in this browser without a global server-side
 * revocation, so the customer's own devices keep their sessions and
 * the admin marker cookie survives untouched — the owner lands back on
 * /ashwini-control still authenticated. A hard navigation (not
 * router.refresh) guarantees no customer-app client state (auth
 * provider caches, plan snapshots) is carried across the boundary.
 */
export function ImpersonationBanner({ customerEmail }: { customerEmail: string | null }) {
  const [exiting, setExiting] = useState(false);

  async function exit() {
    if (exiting) return;
    setExiting(true);
    try {
      // Local scope: drop THIS browser's session, revoke nothing else.
      await createClient().auth.signOut({ scope: 'local' });
    } catch {
      // Even if the client call throws, the cookies are gone or the
      // session is dead — navigating out is still the right answer.
    }
    window.location.href = ADMIN_ROOT;
  }

  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-600/40 bg-amber-500 px-4 py-1.5 text-xs font-medium text-black sm:text-sm"
    >
      <span className="flex items-center gap-1.5">
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden={true} />
        Super Admin session — you are viewing this account
        {customerEmail ? (
          <span className="font-mono font-normal">as {customerEmail}</span>
        ) : null}
        . Password, billing, and API-key changes are disabled.
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void exit()}
        disabled={exiting}
        className="h-6 border-black/30 bg-white/70 px-2 text-xs text-black hover:bg-white"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden={true} />
        {exiting ? 'Exiting…' : 'Exit admin view'}
      </Button>
    </div>
  );
}
