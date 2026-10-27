"use client";

/**
 * Pricing — the template's pricing block: the pill nav (`nav-pills`
 * inside a `bg-primary-gradient rounded-pill`), the cards with a
 * bordered header, the price set in an h1 with the currency and period
 * as `<small>` superscript/subscript, and the check-row feature list.
 *
 * Bootstrap's tab JS (`data-bs-toggle="pill"`) is the only thing
 * replaced: the two panes are React state instead, because pulling
 * bootstrap.bundle.js into the app just for a toggle would put a second
 * UI framework under the dashboard's page. The rendered classes are the
 * ones Bootstrap itself would have produced (`tab-pane fade show active`).
 *
 * The plans are rendered FROM THE DATABASE (`/api/billing/plans` → the
 * same plan/plan_prices/plan_limits rows the enforcement engine reads),
 * so the prices and limits shown here can never drift from what a
 * subscription actually grants. `LANDING_PLANS` remains only as a
 * no-fetch fallback (SSR paint / network error) so the block is never
 * empty. A tiny presentation map (tone / "Most Popular" / CTA verb) is
 * keyed by plan id — those are design choices, not plan numbers, so
 * they're allowed to live in the UI.
 *
 * Monthly / Yearly (spec PART 3):
 *   · the toggle drives the cards IN PLACE; the design is untouched.
 *   · the yearly figures are the STORED yearly rows (052), read through
 *     `cardLimits`/`cardLimitPeriods` — the same overlay rule enforcement
 *     uses, so "shown == enforced". Nothing is multiplied here.
 *   · the choice lives in the URL (`?billing=yearly`) so it can be shared
 *     and survives a refresh; the default is monthly. `window.location`
 *     is used rather than `useSearchParams` to keep this statically
 *     renderable (no Suspense boundary, no client-side bailout of the page).
 *   · the free trial has no yearly version, so its card never changes —
 *     not its figures, not its price suffix.
 *   · a plan with no yearly price row or no stored yearly figures keeps its
 *     monthly offer and says so ("Yearly billing is not available for this
 *     plan yet"); no card ever advertises a checkout that cannot complete.
 *     Payments not being configured is NOT that case — it would stop monthly
 *     as well, so it must not silence a yearly price on the pricing page.
 */

import { useCallback, useEffect, useSyncExternalStore, useState } from "react";

import { LandingIcon, ICON_SIZE } from "@/components/marketing/landing-icons";
import { cardLimitPeriods, cardLimits, type PlanCard } from "@/lib/plans/catalog";
import { TRIAL_DAYS, UNLIMITED, type FeatureFlag, type LimitFeature } from "@/lib/plans/config";
import { formatCount } from "@/lib/currency";

import {
  LANDING_BILLING_PERIODS,
  LANDING_BRAND,
  LANDING_CURRENCY,
  LANDING_PLANS,
  LANDING_PRICING_HEADLINE,
  type LandingPlan,
} from "@/lib/marketing/landing-content";

type BillingPeriod = (typeof LANDING_BILLING_PERIODS)[number]["key"];

/** Shareable cycle selection: `?billing=yearly`. */
const BILLING_PARAM = "billing";

// ---- the cycle choice as an external store ---------------------------
// The URL is the source of truth, so the toggle is read with
// `useSyncExternalStore` rather than `setState` inside an effect: the server
// snapshot is always the monthly default (a statically rendered page cannot
// see a query string, and this is what avoids the hydration mismatch), while
// the first client render already honours a shared `?billing=yearly` link and
// a refresh keeps it. Nothing multiplies here — this only moves a selection.

const periodListeners = new Set<() => void>();

function readPeriodFromUrl(): BillingPeriod {
  const fromUrl = new URLSearchParams(window.location.search).get(BILLING_PARAM);
  return fromUrl === "yearly" ? "yearly" : "monthly";
}

function subscribePeriod(onChange: () => void): () => void {
  periodListeners.add(onChange);
  // Back/forward after an in-page URL rewrite changes `?billing=` without
  // this component remounting.
  window.addEventListener("popstate", onChange);
  return () => {
    periodListeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
  };
}

function getPeriodSnapshot(): BillingPeriod {
  return readPeriodFromUrl();
}

/** Server snapshot / pre-hydration snapshot: monthly is the documented
 *  default, so the shared-card markup never depends on the query string. */
function getPeriodServerSnapshot(): BillingPeriod {
  return "monthly";
}

function writePeriodToUrl(next: BillingPeriod): void {
  // replaceState, not push: switching the toggle is not a navigation the
  // visitor should have to step back through, but the URL must carry the
  // choice so it can be shared and survives a refresh.
  const url = new URL(window.location.href);
  url.searchParams.set(BILLING_PARAM, next);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

// ---- DB → presentational mapping ------------------------------------

// Friendly bullet labels for the counted limits, in the order they read
// best on a card. The window word is NEVER hard-coded here: it comes from
// the stored limit's own period, which is what makes "…/month" on the
// monthly card and "…/year" on the yearly card the same line of code.
const LIMIT_BULLETS: { key: LimitFeature; label: string }[] = [
  { key: "contacts", label: "Contacts" },
  { key: "bulk_messages", label: "Bulk broadcast messages" },
  { key: "templates", label: "Templates" },
  { key: "quick_replies", label: "Quick replies" },
  { key: "automation_flows", label: "Automation flows" },
  { key: "whatsapp_forms", label: "WhatsApp forms" },
  { key: "team_members", label: "Team members" },
];
const FEATURE_BULLETS: { key: FeatureFlag; label: string }[] = [
  { key: "fields_tags", label: "Fields & Tags" },
  { key: "broadcast_scheduler", label: "Broadcast Scheduler" },
  { key: "ai_agent", label: "WhatsApp AI Agent" },
];

// Presentation only — keyed by plan id, with a neutral default. Never
// touches a price or a limit.
const PRESENTATION: Record<string, { tone: "primary" | "secondary"; popular?: boolean }> = {
  trial: { tone: "primary" },
  starter: { tone: "primary" },
  growth: { tone: "secondary", popular: true },
  enterprise: { tone: "secondary" },
};

/** The window word for a figure, from the figure's OWN stored period. */
function periodWord(feature: LimitFeature, period: string | undefined): string {
  if (period === "yearly") return "/year";
  if (period === "monthly") return "/month";
  // 'total' = a count of stored rows (Contacts, Templates…), so it has no
  // window at all. The one exception is the trial's bulk allowance, which
  // is a single pool for the whole 7 days — saying "/month" there was the
  // label bug this file used to have.
  return feature === "bulk_messages" ? ` for ${TRIAL_DAYS} days` : "";
}

function bulletsFor(
  plan: PlanCard,
  cycle: "monthly" | "yearly",
): string[] {
  const limits = cardLimits(plan, cycle);
  const periods = cardLimitPeriods(plan, cycle);
  const out: string[] = [];
  for (const b of LIMIT_BULLETS) {
    const v = limits[b.key];
    if (v === undefined) continue;
    if (v === UNLIMITED) {
      // "Unlimited" stays unlimited on both cycles — only the window word
      // would change, and an unlimited pool has none worth printing.
      out.push(`Unlimited ${b.label.toLowerCase()}`);
    } else {
      out.push(`${formatCount(v)} ${b.label}${periodWord(b.key, periods[b.key])}`);
    }
  }
  for (const f of FEATURE_BULLETS) {
    if (plan.features[f.key]) out.push(f.label);
  }
  out.push("Customer Support");
  return out;
}

// Turn a DB plan row into the shape the card markup consumes.
function toLandingPlan(plan: PlanCard): LandingPlan {
  const pres = PRESENTATION[plan.id] ?? { tone: plan.isPaid ? "secondary" : "primary" };
  const priceFor = (cycle: "monthly" | "yearly") => {
    const p = plan.prices[cycle];
    return p === UNLIMITED || p === 0 ? "0" : formatCount(p);
  };
  const trial = !plan.isPaid;
  return {
    name: plan.tagline && trial ? "7-Day Free Trial" : plan.name,
    tagline: plan.tagline ?? "",
    monthly: priceFor("monthly"),
    // The trial has no yearly version: its "yearly" figure IS its monthly
    // figure so the card cannot change when the toggle moves. A paid plan with
    // no yearly price row keeps its monthly amount too — never "₹0 / Year".
    yearly:
      trial || plan.prices.yearly <= 0 ? priceFor("monthly") : priceFor("yearly"),
    includes: bulletsFor(plan, "monthly"),
    yearlyIncludes: trial ? undefined : bulletsFor(plan, "yearly"),
    yearlyShown: plan.yearlyShown,
    yearlyAvailable: plan.yearlyAvailable,
    tone: pres.tone,
    popular: pres.popular,
    cta: plan.isPaid ? "Subscribe" : "Start free trial",
    trial,
  };
}

export function LandingPricing() {
  const period = useSyncExternalStore(
    subscribePeriod,
    getPeriodSnapshot,
    getPeriodServerSnapshot,
  );
  const [plans, setPlans] = useState<LandingPlan[]>(
    // Fallback so the block renders on the very first paint / if the
    // catalog fetch fails; replaced by DB data below once it resolves.
    LANDING_PLANS
  );
  // The toggle follows the YEARLY_BILLING_ENABLED flag ONLY — exactly as it
  // behaved before yearly billing existed, so it is painted on the server and
  // never disappears because of a half-provisioned offer. Per-plan readiness
  // is a per-card concern: a plan without a complete yearly offer keeps its
  // monthly figures and says so (see `showNote`).
  const [yearlyOn, setYearlyOn] = useState(true);

  const choosePeriod = useCallback((next: BillingPeriod) => {
    if (readPeriodFromUrl() === next) return;
    writePeriodToUrl(next);
    // Notifying the listeners is what re-renders the cards in place: the
    // snapshot the store reports has changed.
    for (const listener of [...periodListeners]) listener();
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/billing/plans", { cache: "default" });
        if (!res.ok) return;
        const data = (await res.json()) as { plans: PlanCard[]; yearlyBilling?: boolean };
        if (!alive || !Array.isArray(data.plans) || data.plans.length === 0) return;
        setPlans(data.plans.map(toLandingPlan));
        // Flag off = the whole cycle is switched off, hide the toggle.
        // Flag on  = the toggle stays, whatever the plans' own state is.
        setYearlyOn(data.yearlyBilling !== false);
      } catch {
        /* keep the LANDING_PLANS fallback */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const showYearly = yearlyOn && period === "yearly";
  const active = LANDING_BILLING_PERIODS.find((option) => option.key === (showYearly ? "yearly" : "monthly"));

  return (
    <div className="container-fluid py-5 anchor" id="pricing">
      <div className="container-xxl py-5 px-lg-5">
        <div className="text-center wow fadeInUp" data-wow-delay="0.1s">
          <h5 className="text-primary-gradient fw-medium">{LANDING_PRICING_HEADLINE.eyebrow}</h5>
          <h1 className="mb-5">{LANDING_PRICING_HEADLINE.headline}</h1>
        </div>

        <div className="tab-class text-center pricing wow fadeInUp" data-wow-delay="0.1s">
          {yearlyOn && (
            <ul className="nav nav-pills d-inline-flex justify-content-center bg-primary-gradient rounded-pill mb-5">
              {LANDING_BILLING_PERIODS.map((option) => (
                <li className="nav-item" key={option.key}>
                  <button
                    type="button"
                    className={`nav-link ${option.key === (showYearly ? "yearly" : "monthly") ? "active" : ""}`}
                    aria-pressed={option.key === (showYearly ? "yearly" : "monthly")}
                    onClick={() => choosePeriod(option.key)}
                  >
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="tab-content text-start">
            <div className="tab-pane fade show active p-0">
              <div className="row g-4">
                {plans.map((plan) => {
                  const trial = Boolean(plan.trial);
                  // Two separate questions, deliberately not the same flag:
                  //   · are there STORED yearly figures to show?  → the numbers
                  //   · does this plan carry a real yearly offer?   → the CTA + note
                  // A card therefore never prints invented numbers, and never
                  // offers a checkout that cannot complete.
                  const hasYearlyFigures =
                    plan.yearlyShown ?? plan.yearlyIncludes !== undefined;
                  const yearlyShown = showYearly && !trial && hasYearlyFigures;
                  const bullets =
                    yearlyShown && plan.yearlyIncludes ? plan.yearlyIncludes : plan.includes;
                  const price = yearlyShown ? plan.yearly : plan.monthly;
                  const suffix = trial
                    ? ` / ${TRIAL_DAYS} days`
                    : yearlyShown
                      ? (active?.suffix ?? "")
                      : (LANDING_BILLING_PERIODS[0]?.suffix ?? "");
                  const unavailableNote =
                    "Yearly billing is not available for this plan yet";
                  const showNote =
                    showYearly && !trial && plan.yearlyAvailable === false;

                  return (
                    <div className="col-lg-3 col-md-6" key={plan.name}>
                      <div
                        className={`bg-light rounded position-relative h-100 ${
                          plan.popular ? "border border-primary border-2" : ""
                        }`}
                      >
                        {plan.popular && (
                          <span className="badge rounded-pill text-white bg-primary-gradient position-absolute top-0 start-50 translate-middle px-3">
                            Most Popular
                          </span>
                        )}
                        <div className="border-bottom p-4 mb-4">
                          <h4 className="text-primary-gradient mb-1">{plan.name}</h4>
                          <span>{plan.tagline}</span>
                        </div>
                        <div className="p-4 pt-0">
                          <h1
                            className="mb-3"
                            title={showNote ? unavailableNote : undefined}
                          >
                            <small
                              className="align-top"
                              style={{ fontSize: 22, lineHeight: "45px" }}
                            >
                              {LANDING_CURRENCY}
                            </small>
                            {price}
                            <small
                              className="align-bottom"
                              style={{ fontSize: 16, lineHeight: "40px" }}
                            >
                              {suffix}
                            </small>
                          </h1>
                          {/* Yearly view, plan with no yearly offer: the note is
                              visible on the card, not hidden in a tooltip —
                              otherwise the card looks like a broken toggle. */}
                          {showNote && (
                            <p className="mb-2" style={{ fontSize: 13, opacity: 0.7 }}>
                              {unavailableNote}
                            </p>
                          )}
                          {bullets.map((item, row) => (
                            <div
                              key={item}
                              className={`d-flex justify-content-between ${
                                row === bullets.length - 1 ? "mb-2" : "mb-3"
                              }`}
                            >
                              <span>{item}</span>
                              <LandingIcon
                                name="fa-check"
                                size={ICON_SIZE.inline}
                                className="text-primary flex-shrink-0 ms-2"
                              />
                            </div>
                          ))}
                          <a
                            href={LANDING_BRAND.signupHref}
                            title={showNote ? unavailableNote : undefined}
                            className={`btn btn-${plan.tone}-gradient rounded-pill py-2 px-4 mt-4`}
                          >
                            {plan.cta ?? "Start free trial"}
                          </a>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
