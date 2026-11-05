"use client";

// ============================================================
// PlanProvider / usePlan — the client mirror of the entitlements
// engine (spec PART 5).
//
// It fetches the SAME snapshot the backend enforces with
// (`/api/billing/entitlements`, itself built on `getEntitlements`),
// so a button the UI enables is a button the API will actually allow,
// and a plan limit shown in the banner is the number enforcement uses.
// Nothing is hard-coded here: plan keys, limits, prices, feature flags
// all come from the database-backed routes.
//
// Two responsibilities:
//   1. Expose plan state + two derived helpers the UI branches on:
//        isFeatureAllowed(flag) and remaining(feature).
//   2. Own the shared upgrade surface. A structured 403 anywhere in
//      the app (see `reportPlanDenial`) opens the picker; so does an expired
//      account's banner. This keeps ONE surface instead of a per-page copy.
//
// That surface has two stages, and the provider owns the handoff between them:
//   · <UpgradeModal> — the plan picker;
//   · <CheckoutScrollOverlay> — the pricing section's animated billing scroller,
//     opened in place for the plan the picker sold. The provider rather than the
//     picker holds it because both ways out are provider state: dismissing it
//     reopens the picker with the denial that raised it (`openUpgrade`), and
//     paying in it closes it and re-reads entitlements (`load`) so the new plan's
//     gates lift WITHOUT navigating anywhere — the customer stays on the page
//     they renewed from. The picker never has to ask its own context to re-open
//     itself, and nothing here changes the landing's or /checkout's copy of the
//     same two components.
//
// UI gating fails OPEN while loading — the authoritative check is the
// backend 403, and we don't want a flash of disabled buttons on every
// navigation. Once loaded, expired/limit/feature gates close.
// ============================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";

import { useAuth } from "@/hooks/use-auth";
import type {
  BillingCycle,
  EffectiveStatus,
  EnforcementResult,
  LimitPeriod,
  PlanKey,
  SubscriptionStatus,
} from "@/lib/plans/types";
import type { FeatureFlag, LimitFeature } from "@/lib/plans/config";
import { UNLIMITED } from "@/lib/plans/config";
import { UpgradeModal, type BillingPick, type UpgradeContext } from "@/components/plans/upgrade-modal";

// Loaded on demand, exactly as the pricing section loads it: the scroller
// portals to document.body and owns framer-motion motion values, neither of
// which has anything to render on the server — and this provider is mounted on
// every dashboard route, so its (scoped) stylesheet must only ship to a customer
// who actually opened a checkout.
const CheckoutScrollOverlay = dynamic(
  () =>
    import("@/components/plans/checkout-scroll-overlay").then(
      (mod) => mod.CheckoutScrollOverlay
    ),
  { ssr: false }
);

// The picker's exit animation is `duration-100` on DialogContent, and until it
// unmounts the modal still holds the page's click and scroll locks — a layer
// opened inside that window is unclickable. So the scroller opens just after the
// handoff, which is short enough to read as one continuous gesture.
const PICKER_HANDOFF_MS = 150;

/** The exact JSON shape returned by GET /api/billing/entitlements. */
interface EntitlementsSnapshot {
  accountId: string;
  plan: PlanKey | null;
  planName: string | null;
  cycle: BillingCycle;
  status: SubscriptionStatus;
  effectiveStatus: EffectiveStatus;
  periodStart: string | null;
  periodEnd: string | null;
  trialClaimedAt: string | null;
  limits: Partial<Record<LimitFeature, number>>;
  limitPeriods: Partial<Record<LimitFeature, LimitPeriod>>;
  usage: Partial<Record<LimitFeature, number>>;
  remaining: Partial<Record<LimitFeature, number>>;
  features: Partial<Record<FeatureFlag, boolean>>;
  featuresAllowed: Partial<Record<FeatureFlag, boolean>>;
}

interface PlanContextValue {
  snapshot: EntitlementsSnapshot | null;
  loading: boolean;
  /** Re-pull the snapshot — call after a renewal so the UI lifts
   *  immediately without a re-login or full refresh (spec PART 3). */
  refresh: () => Promise<void>;
  isExpired: boolean;
  isTrial: boolean;
  /** Feature flag gate; true while loading (fail open). */
  isFeatureAllowed: (flag: FeatureFlag) => boolean;
  /** Remaining capacity for a counted limit; Infinity while loading or
   *  when the plan is unlimited. */
  remaining: (feature: LimitFeature) => number;
  /** True when a counted resource is at/over its cap. */
  isLimitReached: (feature: LimitFeature) => boolean;
  /** Open the shared upgrade/renew modal (e.g. a CTA click). */
  openUpgrade: (ctx?: UpgradeContext) => void;
  closeUpgrade: () => void;
}

const PlanContext = createContext<PlanContextValue | null>(null);

// Global escape hatch so a fetch call-site that received a structured
// 403 can open the modal without prop-drilling the context. The provider
// listens for this event. `detail` is the EnforcementResult body.
export const PLAN_DENIAL_EVENT = "opus:plan-denial";

/**
 * Report a plan denial to the shared modal. Call from any fetch handler
 * that got a 403 whose body matches `EnforcementResult` (`allowed:false`).
 * No-ops on non-plan 403s (role/RLS), so it's safe to call blindly.
 */
export function reportPlanDenial(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Partial<EnforcementResult>;
  if (b.allowed !== false || !b.reason) return false;
  window.dispatchEvent(
    new CustomEvent(PLAN_DENIAL_EVENT, { detail: b as EnforcementResult })
  );
  return true;
}

/** Parse a Response's JSON body and open the upgrade modal if it is a
 *  plan denial. Returns the parsed body (useful to branch further). */
export async function handlePotentialPlanDenial(res: Response): Promise<unknown> {
  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    /* not JSON — leave null */
  }
  if (res.status === 403) reportPlanDenial(body);
  return body;
}

export function PlanProvider({ children }: { children: ReactNode }) {
  const { accountId, accountStatus } = useAuth();
  const [snapshot, setSnapshot] = useState<EntitlementsSnapshot | null>(null);
  // The last account a fetch COMPLETED for (success or failure). `loading`
  // is derived from it (below) instead of a boolean we toggle inside an
  // effect — effects here must only kick off async work, never setState
  // synchronously (react-hooks/set-state-in-effect).
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<{ open: boolean; ctx?: UpgradeContext }>({
    open: false,
  });
  // The billing scroller raised from the picker. It carries the context the
  // picker was opened with, because `closeUpgrade` clears it and dismissing the
  // scroller has to restore the heading and the denial message.
  const [billing, setBilling] = useState<
    (BillingPick & { ctx?: UpgradeContext }) | null
  >(null);
  const handoffRef = useRef<number | null>(null);
  // Guards against an out-of-order response overwriting a newer one
  // (e.g. a refresh racing the initial load).
  const reqIdRef = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqIdRef.current;
    const acct = accountId;
    let data: EntitlementsSnapshot | null = null;
    try {
      const res = await fetch("/api/billing/entitlements", {
        credentials: "include",
        cache: "no-store",
      });
      data = res.ok ? ((await res.json()) as EntitlementsSnapshot) : null;
    } catch {
      data = null;
    }
    // All state updates land after the await — never a sync setState
    // reachable from the effect below.
    if (id === reqIdRef.current) {
      setSnapshot(data);
      setSettledFor(acct);
    }
  }, [accountId]);

  // Pull once the account context is ready (and again on account switch so
  // a shared-account viewer sees the right plan). A snapshot belonging to a
  // different account is masked out below, which naturally re-enters the
  // loading (fail-open) state while the new fetch is in flight.
  useEffect(() => {
    if (accountStatus === "ready" && accountId) {
      // load()'s setStates run only after `await fetch` resolves, never
      // synchronously in the effect body — same exemption pattern the
      // other data-loading surfaces here use.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void load();
    }
  }, [accountStatus, accountId, load]);

  // Mask stale/failure snapshots: only the current account's data counts.
  const accountSnapshot =
    snapshot && accountId && snapshot.accountId === accountId ? snapshot : null;
  const loading =
    accountStatus === "ready" && !!accountId && settledFor !== accountId;

  const openUpgrade = useCallback((ctx?: UpgradeContext) => {
    setUpgrade({ open: true, ctx });
  }, []);
  const closeUpgrade = useCallback(() => setUpgrade({ open: false }), []);

  // Stage two of the upgrade surface: the picker sold a plan, so close it and
  // open the billing scroller over the same page. Nothing is bought here — the
  // scroller's <CheckoutPanel> runs the one shared checkout, and the server
  // still decides the price and the activation.
  const openBilling = useCallback(
    (pick: BillingPick) => {
      const ctx = upgrade.ctx;
      setUpgrade({ open: false });
      if (handoffRef.current) window.clearTimeout(handoffRef.current);
      handoffRef.current = window.setTimeout(() => {
        handoffRef.current = null;
        setBilling({ ...pick, ctx });
      }, PICKER_HANDOFF_MS);
    },
    [upgrade.ctx]
  );

  // Paid, or dismissed. Both close the scroller; only the dismissal reopens the
  // picker, and neither navigates — the customer is left on the page they were
  // already on.
  const closeBilling = useCallback(() => {
    const ctx = billing?.ctx;
    setBilling(null);
    setUpgrade({ open: true, ctx });
  }, [billing?.ctx]);

  // A completed payment changes what the account is allowed to do, so the
  // snapshot is re-read right here — the same call the context exposes as
  // `refresh` — instead of sending the customer to a billing tab to discover it.
  const paidBilling = useCallback(() => {
    setBilling(null);
    void load();
  }, [load]);

  // A handoff still in flight must not open a scroller over a page the user has
  // already left.
  useEffect(
    () => () => {
      if (handoffRef.current) window.clearTimeout(handoffRef.current);
    },
    []
  );

  // Any call-site (or a background 403) can raise the modal via the event.
  useEffect(() => {
    const onDenial = (e: Event) => {
      const detail = (e as CustomEvent<EnforcementResult>).detail;
      setUpgrade({ open: true, ctx: { denial: detail } });
    };
    window.addEventListener(PLAN_DENIAL_EVENT, onDenial);
    return () => window.removeEventListener(PLAN_DENIAL_EVENT, onDenial);
  }, []);

  const value = useMemo<PlanContextValue>(() => {
    const isExpired = accountSnapshot?.effectiveStatus === "expired";
    const isTrial = accountSnapshot?.effectiveStatus === "trialing";
    return {
      snapshot: accountSnapshot,
      loading,
      refresh: load,
      isExpired,
      isTrial,
      isFeatureAllowed: (flag) => {
        // Fail open until loaded. Expired closes everything.
        if (loading) return true;
        if (isExpired) return false;
        return accountSnapshot?.featuresAllowed[flag] !== false;
      },
      remaining: (feature) => {
        if (loading || !accountSnapshot) return Infinity;
        const limit = accountSnapshot.limits[feature];
        if (limit === undefined || limit === UNLIMITED) return Infinity;
        return Math.max(0, limit - (accountSnapshot.usage[feature] ?? 0));
      },
      isLimitReached: (feature) => {
        if (loading || !accountSnapshot) return false;
        const limit = accountSnapshot.limits[feature];
        if (limit === undefined || limit === UNLIMITED) return false;
        return (accountSnapshot.usage[feature] ?? 0) >= limit;
      },
      openUpgrade,
      closeUpgrade,
    };
  }, [accountSnapshot, loading, load, openUpgrade, closeUpgrade]);

  return (
    <PlanContext.Provider value={value}>
      {children}
      <UpgradeModal
        open={upgrade.open}
        ctx={upgrade.ctx}
        onClose={closeUpgrade}
        onPick={openBilling}
      />
      {/* Billing in place — the pricing section's animated scroller, the same
          <CheckoutPanel> `/checkout` renders. It portals to document.body, so
          its place in this tree only decides when it exists. `backLabel` comes
          from the picker (it owns the wording), `onClose` returns to the picker
          and `onPaid` ends the flow on this page. */}
      {billing && (
        <CheckoutScrollOverlay
          planId={billing.planId}
          planName={billing.planName}
          cycle={billing.cycle}
          backLabel={billing.backLabel}
          onClose={closeBilling}
          onPaid={paidBilling}
        />
      )}
    </PlanContext.Provider>
  );
}

/**
 * usePlan — read the account's plan snapshot + gates. Safe outside a
 * provider (returns a loading, fail-open default) so it never crashes a
 * page rendered outside the dashboard shell.
 */
export function usePlan(): PlanContextValue {
  const ctx = useContext(PlanContext);
  if (ctx) return ctx;
  return {
    snapshot: null,
    loading: true,
    refresh: async () => {},
    isExpired: false,
    isTrial: false,
    isFeatureAllowed: () => true,
    remaining: () => Infinity,
    isLimitReached: () => false,
    openUpgrade: () => {},
    closeUpgrade: () => {},
  };
}
