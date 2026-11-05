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
//   · a plan button does not pay in this dialog. It hands the pick up to the
//     provider that renders it (`onPick`), which opens the pricing section's
//     animated billing scroller — <CheckoutScrollOverlay> over <CheckoutPanel>,
//     the ONE billing UI `/checkout` renders too (Orders model, UPI-ready) — IN
//     PLACE, over the page the customer is already on. The server creates/reuses
//     an order at the STORED price, opens checkout.js, verifies the signature +
//     gateway confirmation, and only then activates (or the webhook does), so this
//     dialog never claims a plan the gateway has not confirmed — and the app
//     cannot offer two different billings. Back from the scroller returns here; a
//     paid scroller closes and re-reads entitlements on the same page, so the new
//     plan's limits lift without a navigation. `/checkout?plan=&cycle=` keeps
//     serving middle-click, a shared link, a no-JS visit and the post-login
//     redirect exactly as before.
//
// LAYOUT — why it used to look broken. Three faults stacked, each one
// measured rather than guessed:
//   1. The dialog was never as wide as it looked in the code. `DialogContent`
//      carries `sm:max-w-sm` in its own base classes, and tailwind-merge keeps
//      a plain `max-w-3xl` and a `sm:`-prefixed `sm:max-w-sm` as two different
//      modifier groups — so the old `max-w-3xl` did NOT replace it, and from
//      640px up the dialog was actually 384px (verified by printing the merged
//      class list).
//   2. `lg:grid-cols-4` is a VIEWPORT breakpoint, not a container one, so a
//      1024px screen asked those 384px for four columns: ~86px each. Every
//      label wrapped mid-phrase and every figure collided with it.
//   3. Then it spilled sideways, because a grid item's default `min-width` is
//      `auto` — one string that refuses to wrap (the Button base is
//      `whitespace-nowrap`, and the yearly-unavailable state put the whole
//      sentence "Yearly billing is not available for this plan yet" IN the
//      label) widened its track past the dialog, producing a horizontal
//      scrollbar inside the vertical one.
// The fix is all three: the dialog overrides the same modifier it is fighting
// (`sm:max-w-[min(76rem,calc(100vw-2rem))]`, which twMerge does drop the base
// `sm:max-w-sm` for — also verified), the columns are `sm:2 / xl:4` so four
// side by side only happens when the dialog is genuinely ~1200px wide, and
// every card is `min-w-0` with `whitespace-normal` on the CTA so nothing can
// widen a track again.
//
// The organisation is the enterprise one: fixed header, scrolling body, fixed
// note bar; one card shape with the title block, price, figure list and CTA
// each at the same height on every plan; every row label-left / value-right on
// one baseline with tabular figures, so the columns of numbers actually line up
// across the four cards.
//
// COLOURS: the pricing section's palette, repeated as literal values rather
// than imported. `.text-primary-gradient` / `.bg-primary-gradient` live in
// `src/app/(marketing)/template/style.css`, which only the marketing, checkout
// and legal layouts mount — on a dashboard route those classes do not exist.
// `(auth)/auth-shell.css` sets this precedent already ("the values are repeated
// here rather than imported"). Nothing global is added, so no other component
// can pick these up, and every surface still reads from the theme tokens
// (`bg-popover`, `border-border`, `text-muted-foreground`) so dark mode and the
// accent themes keep working.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCount, formatCurrency } from "@/lib/currency";
import { UNLIMITED, type FeatureFlag, type LimitFeature } from "@/lib/plans/config";
import { cardLimits, cardLimitPeriods, type PlanCard } from "@/lib/plans/catalog";
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

/**
 * What a plan button hands to the provider that renders this dialog: the pick,
 * plus the wording the scroller should use for the way back here. The provider
 * owns the scroller (see `use-plan`), so this is the whole contract between the
 * two stages of the upgrade surface.
 */
export interface BillingPick {
  planId: string;
  planName: string;
  /** The cycle this CARD sold, so a plan without a yearly offer is never asked
   *  for a checkout that cannot complete. */
  cycle: BillingCycle;
  backLabel: string;
}

interface UpgradeModalProps {
  open: boolean;
  ctx?: UpgradeContext;
  onClose: () => void;
  /** A paid plan was clicked: raise the billing scroller for it. */
  onPick: (pick: BillingPick) => void;
  // Deliberately no "renewed" callback: the scroller's host (the provider) is
  // the one that re-reads entitlements when the gateway confirms, so neither
  // this dialog nor the customer has to do anything for the new plan's gates to
  // lift — spec PART 3 still holds.
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

// The pricing section's blue, taken from the palette the template declares once
// in :root: --primary #1d6fb8 into --secondary #165a96, --light #eaf4ff for the
// card wash, --dark #0b2a4a for ink. Complete literal class strings, because
// Tailwind scans source text — a constant is detected exactly as an inline
// class would be.
const BRAND_GRADIENT =
  "[background-image:linear-gradient(to_bottom_right,#1d6fb8,#165a96)]";
// A gradient FILL keeps the same stops in both modes: white measures 5.2:1 on
// #1d6fb8 and 7.2:1 on #165a96, the AA+ the landing documents. Gradient TEXT has
// to invert, because #1d6fb8 on a dark surface is not enough contrast — the
// dark pair is the same hue, lifted.
const BRAND_GRADIENT_TEXT = cn(
  BRAND_GRADIENT,
  "bg-clip-text text-transparent",
  "dark:[background-image:linear-gradient(to_bottom_right,#7cb8e8,#4f9bd6)]"
);
const BRAND_WASH = "bg-[#eaf4ff] dark:bg-[#132437]";
const BRAND_ACCENT = "text-[#165a96] dark:text-[#7cb8e8]";

export function UpgradeModal({ open, ctx, onClose, onPick }: UpgradeModalProps) {
  const t = useTranslations("Plans");
  const { snapshot } = usePlan();
  const [plans, setPlans] = useState<PlanCard[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [cycle, setCycle] = useState<BillingCycle>(snapshot?.cycle ?? "monthly");
  const [yearlyOn, setYearlyOn] = useState(true);
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

    // Yearly not on offer for THIS plan → the button stays disabled, so a
    // checkout that cannot complete still cannot start. The sentence that used
    // to be the label now reads under the price, the way the pricing page shows
    // it (visible on the card, never hidden in a tooltip).
    const unavailable = cycle === "yearly" && !plan.yearlyAvailable;

    const wouldDowngrade =
      Boolean(yearlyLock) && (cycle === "monthly" || plan.sort < currentSort);

    // The verb this card sells, kept short on purpose: it sits on a button in a
    // four-column card, where a long string wraps to three lines and — with the
    // Button's own `whitespace-nowrap` — used to widen the whole column.
    const action = (): string => {
      if (plan.id !== currentPlan) {
        return plan.sort > currentSort ? t("upgrade") : t("switchPlan");
      }
      if (snapshot?.effectiveStatus === "expired") return t("renew");
      // Same plan, monthly after a paid year: blocked, but clickable so it
      // can explain itself.
      if (wouldDowngrade) return t("switchToMonthly");
      return t("switchToYearly");
    };

    if (unavailable) {
      return { label: action(), disabled: true, blocked: "unavailable" };
    }

    return {
      label: action(),
      disabled: false,
      ...(wouldDowngrade ? { blocked: "locked" as const } : {}),
    };
  };

  // Raise the billing scroller for the pick. Two cases are answered HERE instead
  // of sent to a checkout the server would refuse anyway, because the card can
  // say why better than an error on the next screen:
  //   · the trial plan has nothing to buy (the banner / signup flow owns trial
  //     start), so its CTA stays a plain close, not a fake success;
  //   · a downgrade during a paid yearly period is refused with its date.
  const choose = (plan: PlanCard, sellCycle: BillingCycle) => {
    if (!plan.isPaid) {
      onClose();
      return;
    }
  
    // Explain the yearly lock before opening a billing sheet the server would
    // refuse.
    const btn = buttonFor(plan);
    if (btn.blocked === "locked" && yearlyLock) {
      setGatewayNote(t("yearlyLocked", { date: fmtDate(yearlyLock) }));
      return;
    }

    // The cycle bought is the one the CARD sold (a plan with no yearly offer was
    // showing monthly figures), so the scroller is never asked for a checkout that
    // cannot complete. It re-applies the same fallback and the server sets the
    // price — nothing about the offer is trusted from here, and the pay flow stays
    // in the one shared <CheckoutPanel>.
    onPick({
      planId: plan.id,
      planName: plan.name,
      cycle: sellCycle,
      // The scroller's way out is this picker, so it advertises it with the
      // title this dialog actually carries.
      backLabel: t("browseTitle"),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* Fixed header, scrolling body, fixed note bar. `gap-0`/`p-0` replace
          DialogContent's own padding so the three bands run edge to edge and
          only the cards move. */}
      <DialogContent className="flex max-h-[min(90vh,46rem)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-[min(76rem,calc(100vw-2rem))]">
        <DialogHeader className="shrink-0 border-b border-border/70 px-5 pt-5 pb-4 sm:px-6">
          {/* `pe-10` keeps the title clear of the dialog's own close button. */}
          <DialogTitle className="pe-10 text-base leading-snug sm:text-lg">
            {heading}
          </DialogTitle>
          <DialogDescription className="max-w-3xl pe-10">
            {subline}
          </DialogDescription>

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
            {/* Monthly / Yearly — the pricing section's own control: its
                gradient track with a pill sitting in it, so pricing reads
                identically in-app and out. It follows the
                YEARLY_BILLING_ENABLED flag only; a plan that cannot be bought
                yearly yet is answered on its own card, not by hiding the
                toggle. */}
            {yearlyOn && (
              <div
                className={cn(
                  "inline-flex items-center gap-1 rounded-full p-1",
                  BRAND_GRADIENT
                )}
              >
                {(["monthly", "yearly"] as BillingCycle[]).map((c) => {
                  const active = c === cycle;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        setCycle(c);
                        // A message about the cycle you just left must not sit
                        // on top of the one you are now looking at.
                        setGatewayNote(null);
                      }}
                      aria-pressed={active}
                      className={cn(
                        "rounded-full px-4 py-1.5 text-xs font-semibold transition",
                        active
                          ? "bg-white text-[#165a96] shadow-sm dark:bg-[#0b2a4a] dark:text-[#cfe3fa]"
                          : "text-white hover:bg-white/15"
                      )}
                    >
                      {c === "monthly" ? t("monthly") : t("yearly")}
                    </button>
                  );
                })}
              </div>
            )}

            {/* What the account actually holds, so "Change plan" answers a
                question instead of leaving it to memory. */}
            {currentPlan && (
              <p className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">
                  {t("currentPlan")}
                </span>{" "}
                ·{" "}
                {plans?.find((p) => p.id === currentPlan)?.name ?? currentPlan}
                {snapshot?.cycle
                  ? ` · ${snapshot.cycle === "yearly" ? t("yearly") : t("monthly")}`
                  : ""}
              </p>
            )}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {loadErr ? (
            <p className="text-sm text-muted-foreground">{t("catalogError")}</p>
          ) : !plans ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="min-h-[24rem] animate-pulse rounded-2xl border border-border/70 bg-muted"
                />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {plans.map((plan) => {
                const btn = buttonFor(plan);
                const isCurrent = plan.id === currentPlan;
                // The cycle this CARD actually renders. A plan that cannot be
                // bought yearly (no yearly price row / no stored figures) or
                // the free trial keeps its MONTHLY offer instead of printing
                // "₹0/yr" under a disabled button.
                const viewCycle: BillingCycle =
                  cycle === "yearly" && !plan.yearlyAvailable
                    ? "monthly"
                    : cycle;
                const price = plan.prices[viewCycle];
                // Figures come from the STORED row for this cycle (yearly rows
                // when they exist, monthly otherwise) — never multiplied here.
                const limits = cardLimits(plan, viewCycle);
                const periods = cardLimitPeriods(plan, viewCycle);
                // Yearly view, plan with no yearly offer: the explanation goes
                // on the card, the way the pricing page shows it.
                const notOffered =
                  cycle === "yearly" && plan.isPaid && !plan.yearlyAvailable;
                // One shape for both kinds of row, so every line is the same
                // height and every figure lands on the same right edge.
                const rows: { key: string; label: string; value: string | null }[] = [
                  ...LIMIT_KEYS.filter((key) => limits[key] !== undefined).map(
                    (key) => ({
                      key,
                      label: featureLabel(t, key),
                      value:
                        limits[key] === UNLIMITED
                          ? t("unlimited")
                          : `${formatCount(limits[key] as number)}${periodSuffix(
                              t,
                              periods[key]
                            )}`,
                    })
                  ),
                  ...FEATURE_KEYS.filter((key) => plan.features[key]).map(
                    (key) => ({
                      key,
                      label: featureLabel(t, key),
                      value: null,
                    })
                  ),
                ];
                return (
                  <article
                    key={plan.id}
                    aria-current={isCurrent ? "true" : undefined}
                    className={cn(
                      // `min-w-0` is the whole fix for the sideways scrollbar:
                      // a grid track may not shrink below its content unless
                      // the item is allowed to.
                      "flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-popover transition",
                      isCurrent
                        ? "border-[#1d6fb8] shadow-sm dark:border-[#7cb8e8]"
                        : "border-border/80"
                    )}
                  >
                    {/* The pricing card's bordered title block, on its
                        light-blue wash. `min-h` reserves two tagline lines so
                        the price starts at the same height on every card,
                        whether or not the plan has a tagline. */}
                    <header
                      className={cn(
                        "border-b border-border/70 px-4 py-3.5",
                        BRAND_WASH
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3
                          className={cn(
                            "min-w-0 text-sm font-semibold leading-snug",
                            BRAND_GRADIENT_TEXT
                          )}
                        >
                          {plan.name}
                        </h3>
                        {isCurrent && (
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold whitespace-nowrap text-white",
                              BRAND_GRADIENT
                            )}
                          >
                            {t("current")}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 min-h-[2rem] text-xs leading-normal text-muted-foreground">
                        {plan.tagline}
                      </p>
                    </header>

                    <div className="px-4 pt-4">
                      <p className="flex items-baseline gap-1.5">
                        <span className="text-2xl font-bold leading-none tracking-tight tabular-nums text-foreground">
                          {price === UNLIMITED || (price === 0 && !plan.isPaid)
                            ? t("free")
                            : formatCurrency(price, plan.currency)}
                        </span>
                        {plan.isPaid && (
                          <span className="text-xs font-medium text-muted-foreground">
                            {viewCycle === "monthly" ? t("perMonth") : t("perYear")}
                          </span>
                        )}
                      </p>
                      {notOffered && (
                        <p className="mt-2 text-[0.6875rem] leading-snug text-muted-foreground">
                          {t("yearlyUnavailable")}
                        </p>
                      )}
                    </div>

                    {/* flex-1 pushes the CTA to the foot of the card, so the
                        buttons line up across the row however many figures sit
                        above them. */}
                    <ul className="mt-4 flex-1 divide-y divide-border/50 border-t border-border/70 px-4">
                      {rows.map((row) => (
                        <li
                          key={row.key}
                          className="flex items-baseline justify-between gap-3 py-1.5 text-xs"
                        >
                          <span className="min-w-0 flex-1 leading-snug text-muted-foreground">
                            {row.label}
                          </span>
                          {row.value === null ? (
                            <Check
                              aria-hidden={true}
                              className={cn(
                                "size-3.5 shrink-0 self-center",
                                BRAND_ACCENT
                              )}
                            />
                          ) : (
                            <span className="font-semibold tabular-nums whitespace-nowrap text-foreground">
                              {row.value}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>

                    <div className="px-4 pt-4 pb-4">
                      <Button
                        title={notOffered ? t("yearlyUnavailable") : undefined}
                        disabled={btn.disabled}
                        onClick={() => choose(plan, viewCycle)}
                        className={cn(
                          // The Button base is `whitespace-nowrap`; that is
                          // what let a long label widen this card past the
                          // dialog edge.
                          "h-9 w-full rounded-full text-center leading-snug whitespace-normal",
                          btn.disabled || isCurrent
                            ? "border-border bg-muted text-muted-foreground"
                            : cn(
                                "text-white ring-1 ring-inset ring-black/10",
                                BRAND_GRADIENT
                              )
                        )}
                      >
                        {btn.label}
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {gatewayNote && (
          <div className="shrink-0 border-t border-border/70 bg-muted/40 px-5 py-3 sm:px-6">
            <p
              role="status"
              aria-live="polite"
              className="text-xs leading-relaxed text-muted-foreground"
            >
              {gatewayNote}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- helpers ----------------------------------------------------------

// Medium-style date for the "active until" / yearly-lock messages, shared by
// the choose() flow and the yearly-lock explanation so both read identical.
function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

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
