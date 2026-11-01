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

  // Boot-time payment-gateway check: log a clear warning naming any
  // missing RAZORPAY_* value (never a secret's value). Dev does not run
  // register(), so the checkout route calls the same guarded function
  // lazily — see src/lib/plans/gateway/config-check.ts.
  const { checkRazorpayConfigOnce } = await import(
    '@/lib/plans/gateway/config-check'
  );
  checkRazorpayConfigOnce();
}
