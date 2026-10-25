// ============================================================
// Server boot hook (Next.js instrumentation).
//
// Arms the in-process scheduler at server boot. This covers production /
// `next start` where register() reliably runs. It is deliberately paired
// with route-handler arming (see broadcast-scheduler-arm.ts) because the
// register() hook does NOT run under `next dev` — arming from a route that
// the dev server actually executes is what makes scheduling work there.
// Both paths funnel through ensureBroadcastSchedulerArmed(), whose
// globalThis guard means exactly one timer per process regardless.
// ============================================================

export async function register() {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  const { ensureBroadcastSchedulerArmed } = await import(
    '@/lib/whatsapp/broadcast-scheduler-arm'
  );
  ensureBroadcastSchedulerArmed();
}
