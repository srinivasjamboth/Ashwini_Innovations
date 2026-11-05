'use client';

// ============================================================
// CheckoutPanel — the billing UI that `/checkout` renders, extracted
// verbatim so it can also be shown inside the pricing "Billing"
// scroller without a second copy of the logic.
//
// NOTHING about the payment flow changed here: same public catalog
// fetch, same "never advertise a checkout that cannot complete" cycle
// fallback, same `runCheckout` (create/reuse order at the STORED price →
// gateway sheet → server verify → poll), same in-place auth reveal for a
// visitor with no account yet. Only the page container and its "Back to
// pricing" link stayed behind in the route, because those are chrome, not
// billing: the caller decides how the panel is framed (a page column, or the
// scroll card) and passes `className` for the grid.
//
// Two OPTIONAL props exist because a second host now reuses this panel: the
// account's "Renew / Change plan" scroller opens it over the page the customer
// is already on. Such a host owns the exit (`onPaid`) and the wording of the
// escape hatch (`backLabel`). Both default to the landing/page behaviour, so
// `/checkout` and the pricing section render and navigate exactly as before.
// ============================================================

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  cardLimitPeriods,
  cardLimits,
  type PlanCard,
} from '@/lib/plans/catalog';
import {
  FEATURE_FLAGS,
  LIMIT_FEATURES,
  UNLIMITED,
  type FeatureFlag,
  type LimitFeature,
} from '@/lib/plans/config';
import { formatCount, formatCurrency } from '@/lib/currency';
import { runCheckout } from '@/lib/plans/checkout-client';
import { authUrl, LANDING_BRAND } from '@/lib/marketing/landing-content';

// Friendly display labels. Presentation only — never a price or a limit — and
// kept identical in spirit to the landing cards so the two surfaces describe
// the same plan the same way.
const LIMIT_LABELS: Record<LimitFeature, string> = {
  contacts: 'Contacts',
  bulk_messages: 'Bulk broadcast messages',
  templates: 'Templates',
  quick_replies: 'Quick replies',
  automation_flows: 'Automation flows',
  whatsapp_forms: 'WhatsApp forms',
  team_members: 'Team members',
};
const FEATURE_LABELS: Record<FeatureFlag, string> = {
  fields_tags: 'Fields & Tags',
  broadcast_scheduler: 'Broadcast Scheduler',
  ai_agent: 'WhatsApp AI Agent',
};

function periodWord(period: string | undefined): string {
  if (period === 'yearly') return ' / year';
  if (period === 'monthly') return ' / month';
  return '';
}

const CHECK = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="text-primary flex-shrink-0"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export interface CheckoutPanelProps {
  /** Plan id from `?plan=` (the pricing card that was clicked). */
  planId: string | null;
  /** Requested cycle from `?cycle=`; falls back to monthly when the plan
   *  has no real yearly offer, exactly as the server will. */
  cycle: 'monthly' | 'yearly';
  /** Classes for the two-column grid — the page and the scroller want
   *  slightly different gutters. */
  className?: string;
  /** Keep the order summary pinned while the features list scrolls, as the
   *  `/checkout` page always has. Deliberately off inside the scroller:
   *  `position: sticky` is unreliable under a perspective-transformed card,
   *  and there the whole frame scrolls as one. */
  stickySummary?: boolean;
  /** Given by an overlay host: the "pick another plan" escape hatch closes
   *  the panel instead of navigating to a hash on the page it is already on
   *  (which would leave the panel sitting open over the pricing grid).
   *  Omitted on `/checkout`, which keeps its real link. */
  onBackToPricing?: () => void;
  /**
   * Given by a host that keeps the customer where they are: called INSTEAD of
   * the default `router.push('/settings?tab=billing')` once the gateway has
   * confirmed. The account's in-place billing scroller uses it, because after a
   * renew done from the dashboard being sent to a billing tab is a navigation
   * the customer did not ask for. Omitted on `/checkout` and on the pricing
   * section, which keep the push.
   */
  onPaid?: () => void;
  /** Wording of the escape hatch shown when the plan cannot be found. Defaults
   *  to the landing's, which is the only host that navigates to pricing. */
  backLabel?: string;
}

export function CheckoutPanel({
  planId,
  cycle,
  className,
  stickySummary,
  onBackToPricing,
  onPaid,
  backLabel = 'Back to pricing',
}: CheckoutPanelProps) {
  const router = useRouter();

  const [plans, setPlans] = useState<PlanCard[] | null>(null);
  const [failed, setFailed] = useState(false);

  // Checkout UI state — mirrors what the modal / billing tab already do; the
  // server still decides everything (price, verification, activation).
  const [paying, setPaying] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/billing/plans', { cache: 'default' });
        if (!res.ok) {
          if (alive) setFailed(true);
          return;
        }
        const data = (await res.json()) as { plans: PlanCard[] };
        if (alive && Array.isArray(data.plans)) setPlans(data.plans);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const plan = useMemo(
    () => (plans ?? []).find((p) => p.id === planId) ?? null,
    [plans, planId]
  );

  // The cycle we can actually sell: yearly only when the plan carries a real
  // yearly offer, otherwise fall back to monthly (never advertise a checkout
  // that cannot complete). Same rule the landing card and the server apply.
  const shownCycle: 'monthly' | 'yearly' =
    cycle === 'yearly' && plan?.yearlyAvailable ? 'yearly' : 'monthly';
  const amount = plan ? plan.prices[shownCycle] : 0;
  const currency = plan?.currency ?? 'INR';

  const pay = useCallback(async () => {
    if (!plan || !plan.isPaid) return;
    setPaying(true);
    setNote(null);
    setNeedsAuth(false);
    try {
      // The server creates/reuses the order at the STORED price, opens
      // checkout.js, verifies the signature + gateway confirmation, and only
      // then activates. Success is claimed only when the server says so.
      const outcome = await runCheckout(plan.id, shownCycle);
      switch (outcome.status) {
        case 'success':
          if (onPaid) {
            // In-place host: it closes the panel and re-reads entitlements on
            // the current page. No navigation, so the customer never leaves.
            onPaid();
            break;
          }
          // Real billing tab, now that the visitor holds a paid session.
          router.push('/settings?tab=billing');
          break;
        case 'error':
          // A brand-new visitor has no account yet, so the order could not be
          // bound. Reveal the auth step right here instead of navigating away.
          if (outcome.code === 'unauthorized') setNeedsAuth(true);
          else setNote(outcome.message);
          break;
        case 'pending':
          setNote(
            outcome.paymentId
              ? `We are confirming your payment. If money was deducted your plan activates automatically within a few minutes — contact support with payment ID ${outcome.paymentId}.`
              : 'We are confirming your payment — it will activate automatically within a few minutes.'
          );
          break;
        case 'failed':
          setNote('Payment failed. You were not charged — you can try again.');
          break;
        case 'cancelled':
          setNote(
            'Checkout was closed before the payment finished. You were not charged — you can try again.'
          );
          break;
      }
    } finally {
      setPaying(false);
    }
  }, [plan, shownCycle, router, onPaid]);

  // ---- loading / error / invalid states ------------------------------

  if (failed) {
    return (
      <CenterNotice>
        <p className="mb-0">
          The plan could not be loaded right now. Please try again shortly.
        </p>
      </CenterNotice>
    );
  }

  if (!plans) {
    return (
      <div
        className="bg-light mx-auto rounded"
        style={{ height: 320, maxWidth: 720 }}
      />
    );
  }

  if (!plan || !plan.isPaid) {
    return (
      <CenterNotice>
        <h4 className="text-primary-gradient mb-2">Choose a plan</h4>
        <p className="mb-4">
          We could not find that plan. Pick one from the pricing section and try
          again.
        </p>
        {onBackToPricing ? (
          <button
            type="button"
            onClick={onBackToPricing}
            className="btn btn-primary-gradient rounded-pill px-4 py-2"
          >
            {backLabel}
          </button>
        ) : (
          <Link
            href="/#pricing"
            className="btn btn-primary-gradient rounded-pill px-4 py-2"
          >
            {backLabel}
          </Link>
        )}
      </CenterNotice>
    );
  }

  const limits = cardLimits(plan, shownCycle);
  const periods = cardLimitPeriods(plan, shownCycle);

  // ---- the checkout --------------------------------------------------

  return (
    <div className={className ?? 'row g-4 g-lg-5 align-items-start'}>
      {/* Selection + what is included */}
      <div className="col-lg-7">
        <p
          className="text-primary-gradient fw-medium mb-1"
          style={{ letterSpacing: 0.4 }}
        >
          Securing your subscription
        </p>
        <h1 className="mb-1" style={{ fontWeight: 700 }}>
          {plan.name}
        </h1>
        {plan.tagline && <p className="text-muted mb-4">{plan.tagline}</p>}

        <div className="rounded-3 mb-4 border p-4">
          <div className="d-flex justify-content-between align-items-center mb-1">
            <span className="text-muted" style={{ fontSize: 14 }}>
              Billing
            </span>
            <span className="fw-medium">
              {formatCurrency(amount, currency)} ·{' '}
              <span className="text-capitalize">{shownCycle}</span>
            </span>
          </div>
          {cycle === 'yearly' && shownCycle === 'monthly' && (
            <p className="text-muted mt-2 mb-0" style={{ fontSize: 13 }}>
              Yearly billing is not available for this plan yet, so this is the
              monthly price.
            </p>
          )}
        </div>

        <h5 className="mb-3" style={{ fontWeight: 600 }}>
          What is included
        </h5>
        <ul className="list-unstyled mb-0">
          {LIMIT_FEATURES.map((feature: LimitFeature) => {
            const value = limits[feature];
            if (value === undefined) return null;
            const unlimited = value === UNLIMITED;
            return (
              <li
                key={feature}
                className="d-flex justify-content-between align-items-center border-bottom py-2"
              >
                <span>{LIMIT_LABELS[feature]}</span>
                <span className="fw-medium text-end">
                  {unlimited
                    ? 'Unlimited'
                    : `${formatCount(value)}${periodWord(periods[feature])}`}
                </span>
              </li>
            );
          })}
          {FEATURE_FLAGS.map((flag: FeatureFlag) =>
            plan.features[flag] ? (
              <li
                key={flag}
                className="d-flex justify-content-between align-items-center border-bottom py-2"
              >
                <span>{FEATURE_LABELS[flag]}</span>
                {CHECK}
              </li>
            ) : null
          )}
        </ul>
      </div>

      {/* Order summary */}
      <div className="col-lg-5">
        <div
          className="rounded-3 border p-4"
          style={stickySummary ? { position: 'sticky', top: 24 } : undefined}
        >
          <h5 className="mb-4" style={{ fontWeight: 600 }}>
            Order summary
          </h5>

          <div className="d-flex justify-content-between mb-2">
            <span className="text-muted">Plan</span>
            <span className="fw-medium">{plan.name}</span>
          </div>
          <div className="d-flex justify-content-between mb-2">
            <span className="text-muted">Billing cycle</span>
            <span className="fw-medium text-capitalize">{shownCycle}</span>
          </div>

          <hr className="my-3" />

          <div className="d-flex justify-content-between align-items-baseline mb-1">
            <span className="fs-5" style={{ fontWeight: 600 }}>
              Total due today
            </span>
            <span className="fs-4 fw-bold text-primary">
              {formatCurrency(amount, currency)}
            </span>
          </div>
          <p className="text-muted mb-4" style={{ fontSize: 13 }}>
            {shownCycle === 'yearly'
              ? 'Billed once a year.'
              : 'Billed every month.'}
          </p>

          <button
            type="button"
            onClick={() => void pay()}
            disabled={paying}
            className={`btn btn-primary-gradient rounded-pill w-100 py-2 px-4${paying ? 'disabled' : ''}`}
            style={{ fontWeight: 600 }}
          >
            {paying
              ? 'Opening secure payment…'
              : `Pay ${formatCurrency(amount, currency)}`}
          </button>

          <p
            className="d-flex align-items-center justify-content-center text-muted mt-3 mb-0 gap-2"
            style={{ fontSize: 13 }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Secured by Razorpay · UPI, cards, net banking &amp; wallets
          </p>

          {needsAuth && (
            <div
              className="border-top mt-4 pt-4"
              role="status"
              aria-live="polite"
            >
              <p className="mb-3" style={{ fontSize: 14 }}>
                Create an account or log in to complete your subscription. Your
                plan stays selected.
              </p>
              <a
                href={authUrl(LANDING_BRAND.signupHref, plan.id, shownCycle)}
                className="btn btn-primary-gradient rounded-pill mb-2 w-100 px-4 py-2"
              >
                Create account
              </a>
              <a
                href={authUrl(LANDING_BRAND.loginHref, plan.id, shownCycle)}
                className="btn btn-outline-blue rounded-pill w-100 px-4 py-2"
              >
                Log in
              </a>
            </div>
          )}

          {note && (
            <p
              className="text-muted mt-3 mb-0"
              style={{ fontSize: 14 }}
              role="status"
            >
              {note}
            </p>
          )}

          <p className="text-muted mt-4 mb-0" style={{ fontSize: 12 }}>
            By continuing you agree to our Terms &amp; Privacy Policy. Cancel
            anytime — your plan runs to the end of the paid period.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Centered column for the loading / error / no-plan states. */
function CenterNotice({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto py-5 text-center" style={{ maxWidth: 520 }}>
      {children}
    </div>
  );
}
