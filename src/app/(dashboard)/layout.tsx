import type { Metadata } from "next";
import { DashboardShell } from "./dashboard-shell";
import { ensureBroadcastSchedulerArmed } from "@/lib/whatsapp/broadcast-scheduler-arm";

// Server layout whose only job is to declare "do not index" metadata
// for the authed app. robots.ts already disallows these paths at the
// crawler-level and middleware redirects unauthenticated visitors, so
// this is belt-and-suspenders — but SEO-critical if a URL ever leaks
// via a link shared externally.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Arm the in-process broadcast scheduler whenever the authed app renders.
  // register() (instrumentation) does not fire under `next dev`, and arming
  // only from a schedule POST would miss broadcasts already pending after a
  // restart. A guarded, idempotent call here means loading any dashboard
  // page starts the ~30s tick that fires due campaigns. globalThis guard
  // makes this a no-op after the first arm, so it is safe per render.
  ensureBroadcastSchedulerArmed();
  return <DashboardShell>{children}</DashboardShell>;
}
