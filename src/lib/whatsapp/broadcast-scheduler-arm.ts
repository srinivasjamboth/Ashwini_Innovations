// ============================================================
// In-process broadcast scheduler — arming.
//
// Arms a single long-lived timer that fires due scheduled broadcasts by
// calling runScheduledBroadcasts() every tick. This is the trigger that
// makes scheduling work on a self-hosted single server with NO external
// cron pinger.
//
// Why arm from route handlers (not only instrumentation): the Next.js
// `register()` boot hook does NOT reliably run under `next dev` (Turbopack)
// — verified: a long-running dev process never emitted the scheduler log,
// so due broadcasts sat at status='scheduled' forever. Arming from code that
// the running server actually executes (a schedule POST / the cron GET)
// guarantees the timer exists in-process the moment anything touches
// scheduling, with no restart needed.
//
// The guard lives on globalThis (not a module `let`) because per-route
// module instances don't share module scope in dev — the same reason the
// admin session store does this. Exactly one timer runs per process.
//
// Safety: runScheduledBroadcasts claims each campaign with one conditional
// UPDATE ('scheduled' -> 'sending'), so this timer coexisting with an
// external pinger or a manual Resume can never double-send.
// ============================================================

// Fire a few seconds after arming (catch anything already due), then every
// 30s — responsive enough that a broadcast goes out within ~30s of its
// scheduled time, cheap enough to run continuously.
const STARTUP_DELAY_MS = 3_000;
const TICK_INTERVAL_MS = 30_000;

export function ensureBroadcastSchedulerArmed(): void {
  // Node server only; never in Edge middleware / the browser.
  if (typeof globalThis === 'undefined') return;
  if (process.env.NEXT_RUNTIME === 'edge') return;
  if (process.env.BROADCAST_SCHEDULER_DISABLED === 'true') return;

  const g = globalThis as typeof globalThis & {
    __ashwiniBroadcastSchedulerArmed?: boolean;
  };
  if (g.__ashwiniBroadcastSchedulerArmed) return;
  g.__ashwiniBroadcastSchedulerArmed = true;

  const tick = async () => {
    try {
      // Lazy import keeps the Meta-delivery dependency graph off the hot
      // request path and only loads it inside the timer closure.
      const { runScheduledBroadcasts } = await import('./scheduled-broadcast-cron');
      const { fired, skippedExpired, skippedQuota } = await runScheduledBroadcasts();
      if (fired || skippedExpired || skippedQuota) {
        console.log(
          `[broadcast-scheduler] tick: fired=${fired} skippedExpired=${skippedExpired} skippedQuota=${skippedQuota}`,
        );
      }
    } catch (err) {
      // The core already logs scan/delivery failures; never let a tick
      // rejection unwind the server or stop subsequent ticks.
      console.error('[broadcast-scheduler] in-process tick failed:', err);
    }
  };

  setTimeout(() => void tick(), STARTUP_DELAY_MS);
  setInterval(() => void tick(), TICK_INTERVAL_MS);
  console.log('[broadcast-scheduler] in-process scheduler armed (every 30s)');
}
