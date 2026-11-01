/**
 * Razorpay startup configuration check.
 *
 * Surfaces a CLEAR, single warning per process for every required
 * environment value that is missing, so an operator who deploys without
 * the payment keys learns about it in the boot log instead of via a
 * customer hitting a dead "Subscribe" button.
 *
 * NEVER logs a secret value — only the variable NAME and whether it is
 * present. `RAZORPAY_KEY_ID` is the publishable key (safe for the
 * browser); the two others are server-only and are treated as such here.
 *
 * Called from `instrumentation.register()` (production / `next start`)
 * and lazily from the checkout route (dev, where `register()` does not
 * run) — both funnel through the globalThis guard so exactly one warning
 * set is emitted per process.
 */

type RazorpayVar = {
  name: string;
  required: boolean;
  /** Human hint shown alongside the warning. */
  hint: string;
};

const REQUIRED_VARS: RazorpayVar[] = [
  {
    name: 'RAZORPAY_KEY_ID',
    required: true,
    hint: 'publishable key handed to checkout.js (rzp_test_… / rzp_live_…)',
  },
  {
    name: 'RAZORPAY_KEY_SECRET',
    required: true,
    hint: 'server-only secret used to verify payment signatures and call the API',
  },
  {
    name: 'RAZORPAY_WEBHOOK_SECRET',
    required: true,
    hint: 'server-only secret that authenticates POST /api/webhooks/razorpay (activation depends on it)',
  },
];

const GUARD = Symbol.for('opus.razorpayConfigChecked');

interface GuardedGlobal {
  [GUARD]?: boolean;
}

function globalRef(): GuardedGlobal {
  return globalThis as unknown as GuardedGlobal;
}

/**
 * Run the check once per process. Returns the list of missing names so a
 * caller (a route) can branch on it without re-parsing the env. An empty
 * array means Razorpay is fully configured.
 */
export function checkRazorpayConfigOnce(log = console): string[] {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v.name]?.trim()).map((v) => v.name);

  if (globalRef()[GUARD]) return missing;
  globalRef()[GUARD] = true;

  if (missing.length === 0) {
    log.info('[razorpay] payment gateway configured (test/live per key pair).');
    return missing;
  }

  const detail = REQUIRED_VARS.filter((v) => missing.includes(v.name))
    .map((v) => `  · ${v.name} — ${v.hint}`)
    .join('\n');
  log.warn(
    `[razorpay] payment is NOT fully configured — online checkout will answer ` +
      `"gateway_not_configured" until these environment values are set:\n${detail}`,
  );
  return missing;
}

/** Test helper — clears the once-per-process guard so unit tests re-run it. */
export function __resetRazorpayConfigCheckForTests(): void {
  delete globalRef()[GUARD];
}
