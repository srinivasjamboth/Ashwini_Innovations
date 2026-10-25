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
// Subscribe / Upgrade / Switch plan / Current plan / Renew.
//
// Razorpay is intentionally deferred: the checkout call hits the wired
// seam, which returns `gateway_not_configured` (503) until a gateway is
// connected — so the button honestly tells the user payment isn't live
// yet instead of faking success. The whole catalog/CTA surface is real;
// only the money leg is stubbed.
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
import { formatCurrency } from "@/lib/currency";
import { UNLIMITED, type FeatureFlag, type LimitFeature } from "@/lib/plans/config";
import type { PlanCard } from "@/lib/plans/catalog";
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
        const data = (await res.json()) as { plans: PlanCard[] };
        if (alive) setPlans(data.plans);
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

  const currentPlan = snapshot?.plan ?? null;

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

  // Per-plan button state + action label.
  const buttonFor = (plan: PlanCard): { label: string; disabled: boolean } => {
    const isCurrent = plan.id === currentPlan;
    if (isCurrent) {
      // Current paid plan → "Renew"; current free trial → "Current plan".
      if (snapshot?.effectiveStatus === "expired")
        return { label: t("renew"), disabled: false };
      return { label: t("currentPlan"), disabled: true };
    }
    if (!plan.isPaid) {
      // Trial plan. Offer only if no trial has been claimed yet.
      if (snapshot?.trialClaimedAt)
        return { label: t("trialUsed"), disabled: true };
      return { label: t("startTrial"), disabled: false };
    }
    // Upgrade to something above the current tier, otherwise "Switch".
    const currentSort = plans?.find((p) => p.id === currentPlan)?.sort ?? 0;
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
    setPendingPlan(plan.id);
    setGatewayNote(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: plan.id, cycle }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok && typeof body.checkout_url === "string") {
        // Gateway wired later (Razorpay). Real checkouts redirect here.
        window.location.href = body.checkout_url as string;
        return;
      }
      if (body.error === "gateway_not_configured" || res.status === 503) {
        setGatewayNote(t("gatewayPending"));
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
            keeps, so pricing reads identically in-app and out. */}
        <div className="inline-flex rounded-lg border border-border bg-muted p-1 text-sm">
          {(["monthly", "yearly"] as BillingCycle[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCycle(c)}
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
              const price = plan.prices[cycle];
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
                        {cycle === "monthly" ? t("perMonth") : t("perYear")}
                      </span>
                    )}
                  </div>

                  <ul className="mt-3 flex-1 space-y-1 text-xs text-muted-foreground">
                    {LIMIT_KEYS.map((key) =>
                      plan.limits[key] === undefined ? null : (
                        <li key={key} className="flex justify-between gap-2">
                          <span>{featureLabel(t, key)}</span>
                          <span className="font-medium text-foreground">
                            {plan.limits[key] === UNLIMITED
                              ? t("unlimited")
                              : formatLimit(plan.limits[key] as number)}
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

function formatLimit(n: number): string {
  return n.toLocaleString();
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
