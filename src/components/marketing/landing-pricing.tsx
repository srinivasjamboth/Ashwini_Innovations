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
 * The plans are the operator's real tiers (see LANDING_PLANS): four
 * `col-lg-3` cards in rupees, the Growth tier carrying a "Most Popular"
 * badge and an emphasised border. The Monthly/Yearly toggle swaps which
 * price shows; the yearly figure is 12 × monthly.
 * Presentation only — the CTAs point at /signup; there is no billing
 * backend yet. Plain anchors keep the landing CSS on this route.
 */

import { useState } from "react";

import { LandingIcon, ICON_SIZE } from "@/components/marketing/landing-icons";

import {
  LANDING_BILLING_PERIODS,
  LANDING_BRAND,
  LANDING_CURRENCY,
  LANDING_PLANS,
  LANDING_PRICING_HEADLINE,
} from "@/lib/marketing/landing-content";

type BillingPeriod = (typeof LANDING_BILLING_PERIODS)[number]["key"];

export function LandingPricing() {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const active = LANDING_BILLING_PERIODS.find((option) => option.key === period);

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
                {LANDING_PLANS.map((plan) => (
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
