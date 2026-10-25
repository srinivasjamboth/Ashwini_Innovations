"use client";

// ============================================================
// PlanBanner — the persistent, NON-dismissible expired banner
// (spec PART 3).
//
// Shown above every page while the account's effective status is
// `expired`. It reads the same snapshot the API enforces with, so it
// only appears when writes really are being rejected. Dismissing it is
// deliberately impossible: the app is in restricted mode (login / read /
// Billing & Pricing / renew / logout only), and a closable banner would
// let the user forget why their buttons stopped working.
//
// Two copy variants: a lapsed free trial ("Your free trial has ended.
// Choose a plan to continue.") and an expired paid subscription
// ("Your subscription expired on <date>. Renew to continue…").
// ============================================================

import { useTranslations } from "next-intl";

import { usePlan } from "@/hooks/use-plan";
import { Button } from "@/components/ui/button";
import { TriangleAlert } from "lucide-react";

export function PlanBanner() {
  const { snapshot, isExpired, openUpgrade } = usePlan();
  const t = useTranslations("PlanBanner");

  if (!isExpired || !snapshot) return null;

  const trialEnded = !!snapshot.trialClaimedAt && snapshot.status === "trialing";
  const endDate = snapshot.periodEnd
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
        new Date(snapshot.periodEnd)
      )
    : null;

  return (
    <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-500" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {trialEnded ? t("trialEnded") : t("subscriptionExpired", { date: endDate ?? "" })}
            </p>
            <p className="text-xs text-muted-foreground">
              {trialEnded ? t("trialEndedBody") : t("subscriptionExpiredBody")}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => openUpgrade({ intent: trialEnded ? "upgrade" : "renew" })}
        >
          {trialEnded ? t("choosePlan") : t("renew")}
        </Button>
      </div>
    </div>
  );
}
