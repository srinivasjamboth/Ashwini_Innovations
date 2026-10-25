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
 * they're allowed to live in the UI. The Monthly/Yearly toggle is
 * unchanged; the yearly figure is the DB's `plan_prices` yearly row
 * (seeded 12 × monthly), not a client-side multiply.
 */

import { useEffect, useState } from "react";

import { LandingIcon, ICON_SIZE } from "@/components/marketing/landing-icons";
import type { PlanCard } from "@/lib/plans/catalog";
import { UNLIMITED, type LimitFeature, type FeatureFlag } from "@/lib/plans/config";

import {
  LANDING_BILLING_PERIODS,
  LANDING_BRAND,
  LANDING_CURRENCY,
  LANDING_PLANS,
  LANDING_PRICING_HEADLINE,
  type LandingPlan,
} from "@/lib/marketing/landing-content";

type BillingPeriod = (typeof LANDING_BILLING_PERIODS)[number]["key"];

// ---- DB → presentational mapping ------------------------------------

// Friendly bullet labels for the counted limits, in the order they read
// best on a card. `perMonth` marks a monthly-reset quota.
const LIMIT_BULLETS: { key: LimitFeature; label: string; perMonth?: boolean }[] = [
  { key: "contacts", label: "Contacts" },
  { key: "bulk_messages", label: "Bulk broadcast messages", perMonth: true },
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

function formatAmount(n: number): string {
  return n.toLocaleString("en-IN");
}

// Turn a DB plan row into the shape the card markup consumes.
function toLandingPlan(plan: PlanCard): LandingPlan {
  const includes: string[] = [];
  for (const b of LIMIT_BULLETS) {
    const v = plan.limits[b.key];
    if (v === undefined) continue;
    const qty = v === UNLIMITED ? "Unlimited" : formatAmount(v);
    if (v === UNLIMITED) {
      includes.push(`Unlimited ${b.label.toLowerCase()}`);
    } else {
      includes.push(`${qty} ${b.label}${b.perMonth ? "/month" : ""}`);
    }
  }
  for (const f of FEATURE_BULLETS) {
    if (plan.features[f.key]) includes.push(f.label);
  }
  includes.push("Customer Support");

  const pres = PRESENTATION[plan.id] ?? { tone: plan.isPaid ? "secondary" : "primary" };
  const priceFor = (cycle: "monthly" | "yearly") => {
    const p = plan.prices[cycle];
    return p === UNLIMITED || p === 0 ? "0" : formatAmount(p);
  };
  return {
    name: plan.tagline && plan.id === "trial" ? "7-Day Free Trial" : plan.name,
    tagline: plan.tagline ?? "",
    monthly: priceFor("monthly"),
    yearly: priceFor("yearly"),
    includes,
    tone: pres.tone,
    popular: pres.popular,
    cta: plan.isPaid ? "Subscribe" : "Start free trial",
  };
}

export function LandingPricing() {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const [plans, setPlans] = useState<LandingPlan[]>(
    // Fallback so the block renders on the very first paint / if the
    // catalog fetch fails; replaced by DB data below once it resolves.
    LANDING_PLANS
  );
  const active = LANDING_BILLING_PERIODS.find((option) => option.key === period);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/billing/plans", { cache: "default" });
        if (!res.ok) return;
        const data = (await res.json()) as { plans: PlanCard[] };
        if (alive && Array.isArray(data.plans) && data.plans.length > 0) {
          setPlans(data.plans.map(toLandingPlan));
        }
      } catch {
        /* keep the LANDING_PLANS fallback */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="container-fluid py-5 anchor" id="pricing">
      <div className="container-xxl py-5 px-lg-5">
        <div className="text-center wow fadeInUp" data-wow-delay="0.1s">
          <h5 className="text-primary-gradient fw-medium">{LANDING_PRICING_HEADLINE.eyebrow}</h5>
          <h1 className="mb-5">{LANDING_PRICING_HEADLINE.headline}</h1>
        </div>

        <div className="tab-class text-center pricing wow fadeInUp" data-wow-delay="0.1s">
          <ul className="nav nav-pills d-inline-flex justify-content-center bg-primary-gradient rounded-pill mb-5">
            {LANDING_BILLING_PERIODS.map((option) => (
              <li className="nav-item" key={option.key}>
                <button
                  type="button"
                  className={`nav-link ${option.key === period ? "active" : ""}`}
                  aria-pressed={option.key === period}
                  onClick={() => setPeriod(option.key)}
                >
                  {option.label}
                </button>
              </li>
            ))}
          </ul>

          <div className="tab-content text-start">
            <div className="tab-pane fade show active p-0">
              <div className="row g-4">
                {plans.map((plan) => (
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
                        <h1 className="mb-3">
                          <small
                            className="align-top"
                            style={{ fontSize: 22, lineHeight: "45px" }}
                          >
                            {LANDING_CURRENCY}
                          </small>
                          {plan[period]}
                          <small
                            className="align-bottom"
                            style={{ fontSize: 16, lineHeight: "40px" }}
                          >
                            {active?.suffix}
                          </small>
                        </h1>
                        {plan.includes.map((item, row) => (
                          <div
                            key={item}
                            className={`d-flex justify-content-between ${
                              row === plan.includes.length - 1 ? "mb-2" : "mb-3"
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
                          className={`btn btn-${plan.tone}-gradient rounded-pill py-2 px-4 mt-4`}
                        >
                          {plan.cta ?? "Start free trial"}
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
