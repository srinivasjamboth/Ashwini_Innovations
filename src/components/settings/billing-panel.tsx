"use client";

// ============================================================
// BillingPanel — Settings → Billing & plan (spec PART 5).
//
// Shows the account's current plan, cycle, renewal/expiry date, per-limit
// usage ("Contacts: 850 / 1,000"), and payment history — all read from
// the same DB-backed routes the enforcement engine uses, so the numbers
// shown are the numbers the API checks. "Change plan" opens the shared
// UpgradeModal (rendered by the PlanProvider), not a bespoke one.
// ============================================================

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { usePlan } from "@/hooks/use-plan";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LIMIT_FEATURES, UNLIMITED, type LimitFeature } from "@/lib/plans/config";
import { formatCount, formatCurrency } from "@/lib/currency";

interface PaymentRow {
  id: string;
  plan_id: string;
  billing_cycle: string | null;
  gateway: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  created_at: string | null;
}

export function BillingPanel() {
  const t = useTranslations("Billing");
  const tp = useTranslations("Plans");
  const { snapshot, loading, openUpgrade, isExpired } = usePlan();
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/billing/payments", { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as { payments: PaymentRow[] };
        if (alive) setPayments(data.payments);
      } catch {
        /* leave null → empty state */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading || !snapshot) {
    return (
      <div className="space-y-3">
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  const fmtDate = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso)) : "—";

  const statusLabel =
    snapshot.effectiveStatus === "expired"
      ? t("statusExpired")
      : snapshot.effectiveStatus === "trialing"
        ? t("statusTrial")
        : t("statusActive");

  return (
    <div className="space-y-6">
      {/* Current plan */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">{t("currentPlanTitle")}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {snapshot.planName ?? snapshot.plan ?? "—"} ·{" "}
              {snapshot.cycle === "yearly" ? tp("yearly") : tp("monthly")}
            </p>
          </div>
          <Badge variant={isExpired ? "destructive" : "secondary"}>{statusLabel}</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <p className="text-muted-foreground">{t("periodStart")}</p>
              <p className="font-medium">{fmtDate(snapshot.periodStart)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">
                {snapshot.effectiveStatus === "trialing" ? t("trialEnds") : t("renewsOn")}
              </p>
              <p className="font-medium">{fmtDate(snapshot.periodEnd)}</p>
            </div>
          </div>
          <Button size="sm" onClick={() => openUpgrade({ intent: isExpired ? "renew" : "upgrade" })}>
            {isExpired ? t("renewPlan") : t("changePlan")}
          </Button>
        </CardContent>
      </Card>

      {/* Usage vs limits */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("usageTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {LIMIT_FEATURES.map((feature: LimitFeature) => {
              const limit = snapshot.limits[feature];
              if (limit === undefined) return null;
              const used = snapshot.usage[feature] ?? 0;
              const unlimited = limit === UNLIMITED;
              const atCap = !unlimited && used >= limit;
              // The window is the figure's OWN stored period, so a yearly
              // plan reads "4,200 / 60,000 this year" and a monthly plan
              // keeps "… this month" — same component, no special-casing of
              // numbers (they arrive yearly from the entitlement service).
              const period = snapshot.limitPeriods[feature];
              const window =
                period === "yearly" ? t("windowYearly") : period === "monthly" ? t("windowMonthly") : null;
              return (
                <li key={feature} className="text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">
                      {tp(`limits.${feature}`)}
                      {window ? <span className="ms-1 text-xs">· {window}</span> : null}
                    </span>
                    <span className={atCap ? "font-medium text-amber-600" : "font-medium"}>
                      {formatCount(used)} / {unlimited ? tp("unlimited") : formatCount(limit)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${atCap ? "bg-amber-500" : "bg-primary"}`}
                      style={{
                        width: unlimited
                          ? "100%"
                          : `${Math.min(100, limit === 0 ? 100 : (used / limit) * 100)}%`,
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {/* Payment history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("historyTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {payments === null ? (
            <p className="text-sm text-muted-foreground">{t("loadingHistory")}</p>
          ) : payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noPayments")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">{t("date")}</th>
                    <th className="py-2 pr-4 font-medium">{t("plan")}</th>
                    <th className="py-2 pr-4 font-medium">{t("amount")}</th>
                    <th className="py-2 font-medium">{t("status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 text-muted-foreground">{fmtDate(p.created_at)}</td>
                      <td className="py-2 pr-4">
                        {p.plan_id}
                        {p.billing_cycle === "yearly" ? (
                          <span className="ms-1 text-xs text-muted-foreground">· {tp("yearly")}</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4">
                        {p.amount != null ? formatCurrency(p.amount, p.currency ?? "INR") : "—"}
                      </td>
                      <td className="py-2">{p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
