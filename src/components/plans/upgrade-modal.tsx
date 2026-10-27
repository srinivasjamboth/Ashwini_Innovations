"use client";

// ============================================================
// UpgradeModal — the single shared upgrade / renew dialog
// (spec PART 3/5).
//
// Opened by the PlanProvider either from a structured 403 (a limit /
// feature / expiry denial) or an explicit "Upgrade" CTA. It renders the
// plan catalog FROM THE DATABASE (`/api/billing/plans` → the same rows
// enforcement uses), keeps the Monthly/Yearly toggle, and shows the
// correct button state per plan: Start free trial / Trial used /
// Subscribe / Upgrade / Switch to yearly / Switch to monthly / Current
// plan / Renew.
//
// Yearly (spec PART 3/4):
//   · the card figures are the STORED per-cycle rows (`cardLimits`), the
//     same overlay enforcement applies — nothing is multiplied here;
//   · a plan with no yearly price row or no stored yearly figures is NOT
//     offered yearly: it keeps its monthly offer and its button explains why,
//     so the dialog never starts a checkout that cannot complete. A missing
//     payment-provider configuration is a different thing entirely — it stops
//     MONTHLY too — so it is answered when the button is clicked
//     ("Online payment isn't set up yet"), not by disabling every card;
//   · while a PAID yearly period runs, a downgrade (cheaper plan, or back
//     to monthly) is refused with "Your yearly plan runs until <date>" —
//     the same rule the checkout route enforces server-side;
//   · checkout creates a Razorpay subscription and hands it to checkout.js.
//     Activation still only happens on the verified webhook, so this dialog
//     never claims a plan the gateway has not confirmed.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCount, formatCurrency } from "@/lib/currency";
import { UNLIMITED, type FeatureFlag, type LimitFeature } from "@/lib/plans/config";
import { cardLimits, cardLimitPeriods, type PlanCard } from "@/lib/plans/catalog";
import { openRazorpaySubscription } from "@/lib/plans/gateway/razorpay-client";
import type { BillingCycle, EnforcementResult } from "@/lib/plans/types";
import { usePlan } from "@/hooks/use-plan";

export interface UpgradeContext {
  /** The denial that opened the modal, if any. */
  denial?: EnforcementResult;
  /** Explicit intent from a CTA click. */
  intent?: "upgrade" | "renew" | "browse";
  /** The counted limit a gated CTA tripped (for future copy tailoring). */
  feature?: string;
  /** The feature flag a gated CTA tripped. */
  flag?: string;
}

interface UpgradeModalProps {
  open: boolean;
  ctx?: UpgradeContext;
  onClose: () => void;
  /** Called after a successful renewal so the snapshot lifts
   *  immediately (spec PART 3: no re-login / refresh). */
  onRenewed: () => void;
}

// Feature display names, resolved through the Plans namespace so every
// key ships in all four locales (i18n parity test enforces this).
const LIMIT_KEYS: LimitFeature[] = [
  "contacts",
  "bulk_messages",
  "templates",
  "quick_replies",
  "automation_flows",
  "whatsapp_forms",
  "team_members",
];
const FEATURE_KEYS: FeatureFlag[] = [
  "fields_tags",
  "broadcast_scheduler",
  "ai_agent",
];

export function UpgradeModal({ open, ctx, onClose, onRenewed }: UpgradeModalProps) {
  const t = useTranslations("Plans");
  const { snapshot } = usePlan();
  const [plans, setPlans] = useState<PlanCard[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [cycle, setCycle] = useState<BillingCycle>(snapshot?.cycle ?? "monthly");
  const [yearlyOn, setYearlyOn] = useState(true);
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [gatewayNote, setGatewayNote] = useState<string | null>(null);

  // Fetch the catalog lazily, only when the dialog opens, and keep it for
  // subsequent opens within the session (it changes only when the seed
  // / admin edits plan rows).
  useEffect(() => {
    if (!open || plans || loadErr) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/billing/plans", { cache: "default" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { plans: PlanCard[]; yearlyBilling?: boolean };
        if (!alive) return;
        setPlans(data.plans);
        // The toggle mirrors the YEARLY_BILLING_ENABLED flag, nothing else —
        // the same rule the landing page uses. Whether a PARTICULAR plan can
        // be bought yearly is answered per card (see `buttonFor`).
        setYearlyOn(data.yearlyBilling !== false);
      } catch {
        if (alive) setLoadErr(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, plans, loadErr]);

  // Sync the toggle to the account's actual cycle when it's known.
  useEffect(() => {
    if (snapshot?.cycle) setCycle(snapshot.cycle);
  }, [snapshot?.cycle]);

  // Never leave the dialog parked on a cycle that is not on offer.
  useEffect(() => {
    if (!yearlyOn && cycle !== "monthly") setCycle("monthly");
  }, [yearlyOn, cycle]);

  const currentPlan = snapshot?.plan ?? null;

  // A paid YEARLY period that is still running may not be traded down —
  // the mirror of the server rule, so the dialog can explain it before the
  // customer clicks (and the checkout route still refuses if they do).
  const yearlyLock = useMemo(() => {
    if (!snapshot || snapshot.effectiveStatus === "expired") return null;
    if (snapshot.cycle !== "yearly" || snapshot.plan === "trial") return null;
    return snapshot.periodEnd ?? null;
  }, [snapshot]);

  const heading = useMemo(() => {
    const reason = ctx?.denial?.reason;
    if (reason === "subscription_expired") return t("expiredTitle");
    if (reason === "limit_reached") return t("limitTitle");
    if (reason === "feature_not_included") return t("featureTitle");
    if (ctx?.intent === "renew") return t("renewTitle");
    return t("browseTitle");
  }, [ctx, t]);

  const subline = useMemo(() => {
    const d = ctx?.denial;
    if (!d) return t("browseBody");
    if (d.reason === "limit_reached")
      return t("limitBody", {
        feature: featureLabel(t, d.feature),
        current: d.current,
        limit: d.limit === UNLIMITED ? t("unlimited") : d.limit,
      });
    if (d.reason === "feature_not_included")
      return t("featureBody", { feature: featureLabel(t, d.feature) });
    return t("expiredBody");
  }, [ctx, t]);

  // Per-plan button state + action label. The viewed `cycle` is part of the
  // state: "Current plan" only when plan AND cycle both match, so the same
  // plan on the other cycle offers the switch (spec PART 3).
  const currentSort = plans?.find((p) => p.id === currentPlan)?.sort ?? 0;
  const buttonFor = (
    plan: PlanCard,
  ): { label: string; disabled: boolean; blocked?: 'unavailable' | 'locked' } => {
    if (!plan.isPaid) {
      // Trial plan. Offer only if no trial has been claimed yet. The trial
      // has no yearly version, so the cycle never changes this button.
      if (snapshot?.trialClaimedAt) return { label: t("trialUsed"), disabled: true };
      return { label: t("startTrial"), disabled: false };
    }

    // "Current plan" states a fact about what the customer already holds, so
    // it outranks the yearly-availability message: an account on an
    // owner-granted yearly period must never be told its own plan "is not
    // available". Expired is excluded — that card offers Renew instead.
    if (
      plan.id === currentPlan &&
      snapshot?.cycle === cycle &&
      snapshot.effectiveStatus !== "expired"
    ) {
      return { label: t("currentPlan"), disabled: true };
    }

    // Yearly not on offer for THIS plan → say so, and do not start a
    // checkout that cannot complete.
    if (cycle === "yearly" && !plan.yearlyAvailable) {
      return { label: t("yearlyUnavailable"), disabled: true, blocked: "unavailable" };
    }

    const wouldDowngrade =
      Boolean(yearlyLock) && (cycle === "monthly" || plan.sort < currentSort);

    if (plan.id === currentPlan) {
      if (snapshot?.effectiveStatus === "expired")
        return { label: t("renew"), disabled: false };
      if (wouldDowngrade) {
        // Same plan, monthly after a paid year: blocked, but clickable so it
        // can explain itself.
        return { label: t("switchToMonthly"), disabled: false, blocked: "locked" };
      }
      return { label: t("switchToYearly"), disabled: false };
    }

    if (wouldDowngrade)
      return { label: plan.sort > currentSort ? t("upgrade") : t("switchPlan"), disabled: false, blocked: "locked" };

    return {
      label: plan.sort > currentSort ? t("upgrade") : t("switchPlan"),
      disabled: false,
    };
  };

  const choose = async (plan: PlanCard) => {
    if (!plan.isPaid) {
      // Trial is granted automatically at signup; there is nothing to
      // "buy", so a trial CTA here just closes the dialog (the banner /
      // signup flow owns trial start). Kept as a no-op, not a fake success.
      onClose();
      return;
    }

    // Explain the yearly lock before spending a network call on a checkout
    // the server would refuse anyway.
    const btn = buttonFor(plan);
    if (btn.blocked === "locked" && yearlyLock) {
      setGatewayNote(
        t("yearlyLocked", {
          date: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(yearlyLock)),
        }),
      );
      return;
    }

    setPendingPlan(plan.id);
    setGatewayNote(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // `planId` is the documented key; the route also accepts the old
        // `plan` spelling, but this dialog must not rely on that.
        body: JSON.stringify({ planId: plan.id, cycle }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        checkout_url?: string;
        keyId?: string;
        subscriptionId?: string;
        error?: string;
        blockedUntil?: string | null;
      };
      if (res.ok && typeof body.checkout_url === "string") {
        window.location.href = body.checkout_url;
        return;
      }
      if (res.ok && body.keyId && body.subscriptionId) {
        const result = await openRazorpaySubscription({
          keyId: body.keyId,
          subscriptionId: body.subscriptionId,
        });
        if (result) {
          // Authorized. The plan flips when the verified webhook lands, which
          // is normally a second later — poll the snapshot rather than
          // claiming success here.
          setGatewayNote(t("paymentProcessing"));
          onRenewed();
          window.setTimeout(onRenewed, 2500);
          window.setTimeout(onRenewed, 6000);
        } else {
          setGatewayNote(t("checkoutCancelled"));
        }
        return;
      }
      if (body.error === "yearly_period_active") {
        setGatewayNote(
          t("yearlyLocked", {
            date: body.blockedUntil
              ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(body.blockedUntil))
              : "—",
          }),
        );
      } else if (body.error === "gateway_not_configured" || res.status === 503) {
        setGatewayNote(t("gatewayPending"));
      } else if (body.error === "yearly_unavailable") {
        setGatewayNote(t("yearlyUnavailable"));
      } else {
        setGatewayNote(t("checkoutError"));
      }
    } catch {
      setGatewayNote(t("checkoutError"));
    } finally {
      setPendingPlan(null);
      // A successful redirect never reaches here; if we did renew,
      // refresh the snapshot so gating lifts without a reload.
      onRenewed();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{subline}</DialogDescription>
        </DialogHeader>

        {/* Monthly / Yearly toggle — the same control the landing page
            keeps, so pricing reads identically in-app and out. It follows the
            YEARLY_BILLING_ENABLED flag only; a plan that cannot be bought
            yearly yet is answered on its own card, not by hiding the
            toggle. */}
        {yearlyOn && (
          <div className="inline-flex rounded-lg border border-border bg-muted p-1 text-sm">
            {(["monthly", "yearly"] as BillingCycle[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setCycle(c);
                  // A message about the cycle you just left must not sit on
                  // top of the one you are now looking at.
                  setGatewayNote(null);
                }}
                aria-pressed={c === cycle}
                className={`rounded-md px-3 py-1 font-medium transition ${
                  c === cycle
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {c === "monthly" ? t("monthly") : t("yearly")}
              </button>
            ))}
          </div>
        )}

        {loadErr ? (
          <p className="text-sm text-muted-foreground">{t("catalogError")}</p>
        ) : !plans ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-52 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {plans.map((plan) => {
              const btn = buttonFor(plan);
              // The cycle this CARD actually renders. A plan that cannot be
              // bought yearly (no yearly price row / no stored figures) or the
              // free trial keeps its MONTHLY offer instead of printing "₹0/yr"
              // under a disabled button.
              const viewCycle: BillingCycle =
                cycle === "yearly" && !plan.yearlyAvailable ? "monthly" : cycle;
              const price = plan.prices[viewCycle];
              // Figures come from the STORED row for this cycle (yearly rows
              // when they exist, monthly otherwise) — never multiplied here.
              const limits = cardLimits(plan, viewCycle);
              const periods = cardLimitPeriods(plan, viewCycle);
              return (
                <div
                  key={plan.id}
                  className={`flex flex-col rounded-xl border p-4 ${
                    plan.id === currentPlan
                      ? "border-primary bg-primary/5"
                      : "border-border"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-foreground">{plan.name}</h3>
                    {plan.id === currentPlan && (
                      <Badge variant="secondary">{t("current")}</Badge>
                    )}
                  </div>
                  {plan.tagline && (
                    <p className="mt-1 text-xs text-muted-foreground">{plan.tagline}</p>
                  )}
                  <div className="mt-3">
                    <span className="text-2xl font-bold text-foreground">
                      {price === UNLIMITED || (price === 0 && !plan.isPaid)
                        ? t("free")
                        : formatCurrency(price, plan.currency)}
                    </span>
                    {plan.isPaid && (
                      <span className="text-xs text-muted-foreground">
                        {viewCycle === "monthly" ? t("perMonth") : t("perYear")}
                      </span>
                    )}
                  </div>

                  <ul className="mt-3 flex-1 space-y-1 text-xs text-muted-foreground">
                    {LIMIT_KEYS.map((key) =>
                      limits[key] === undefined ? null : (
                        <li key={key} className="flex justify-between gap-2">
                          <span>{featureLabel(t, key)}</span>
                          <span className="font-medium text-foreground">
                            {limits[key] === UNLIMITED
                              ? t("unlimited")
                              : `${formatCount(limits[key] as number)}${periodSuffix(t, periods[key])}`}
                          </span>
                        </li>
                      )
                    )}
                    {FEATURE_KEYS.map((key) =>
                      plan.features[key] ? (
                        <li key={key} className="flex justify-between gap-2">
                          <span>{featureLabel(t, key)}</span>
                          <span className="font-medium text-foreground">✓</span>
                        </li>
                      ) : null
                    )}
                  </ul>

                  <Button
                    className="mt-4"
                    variant={plan.id === currentPlan ? "outline" : "default"}
                    disabled={btn.disabled || pendingPlan === plan.id}
                    onClick={() => choose(plan)}
                  >
                    {pendingPlan === plan.id ? t("working") : btn.label}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {gatewayNote && (
          <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            {gatewayNote}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- helpers ----------------------------------------------------------

// The window a figure is measured over, read from the row's own stored
// period: a yearly bulk quota says "/year", a monthly one "/month", a
// whole-plan/whole-trial figure says nothing. Data-driven, so a later
// period change in the DB re-labels the card without a code edit.
function periodSuffix(
  t: ReturnType<typeof useTranslations>,
  period: string | undefined
): string {
  if (period === "yearly") return t("perYear");
  if (period === "monthly") return t("perMonth");
  return "";
}

// Resolve a feature/limit key to its translated label, falling back to a
// humanised version of the key if a locale is somehow missing the entry
// (defensive — the parity test should prevent that).
function featureLabel(
  t: ReturnType<typeof useTranslations>,
  key: string
): string {
  // next-intl throws on missing keys, so probe with t.has when available
  // and fall back to a humanised key otherwise (defensive — the locale
  // parity test should prevent a real miss).
  try {
    if (t.has(`limits.${key}`)) return t(`limits.${key}`);
  } catch {
    /* t.has unsupported — fall through */
  }
  try {
    if (t.has(`features.${key}`)) return t(`features.${key}`);
  } catch {
    /* noop */
  }
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
