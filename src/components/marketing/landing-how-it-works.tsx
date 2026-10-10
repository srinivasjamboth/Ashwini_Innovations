import { LandingIcon, ICON_SIZE } from "@/components/marketing/landing-icons";
import { LANDING_HOW_IT_WORKS, LANDING_STEPS } from "@/lib/marketing/landing-content";

/**
 * How It Works — the template's "Process" section, rule for rule: the
 * centred eyebrow + headline, the three cards with a 100px gradient
 * circle floating on the top edge (`position-absolute translate-middle`
 * with a shadow), and the same col-lg-4 / col-sm-6 wrap with staggered
 * fadeInUp delays.
 *
 * Only the words changed. The template's steps were "Install the App /
 * Setup Your Profile / Enjoy The Features", which describe an app
 * install this product does not have, and the body text under each was
 * the vendor's filler.
 */
export function LandingHowItWorks() {
  return (
    <div className="container-fluid py-5 anchor">
      <div className="container-xxl py-5 px-lg-5">
        <div className="text-center pb-4 wow fadeInUp" data-wow-delay="0.1s">
          <h5 className="text-primary-gradient fw-medium">{LANDING_HOW_IT_WORKS.eyebrow}</h5>
          <h1 className="mb-5">{LANDING_HOW_IT_WORKS.headline}</h1>
        </div>
        <div className="row gy-5 gx-4 justify-content-center">
          {LANDING_STEPS.map((step, i) => (
            <div
              key={step.index}
              className="col-lg-4 col-sm-6 text-center pt-4 wow fadeInUp"
              data-wow-delay={`${0.1 + i * 0.2}s`}
            >
              <div className="position-relative bg-light rounded pt-5 pb-4 px-4">
                <div
                  className={`d-inline-flex align-items-center justify-content-center bg-${step.tone}-gradient rounded-circle position-absolute top-0 start-50 translate-middle shadow`}
                  style={{ width: 100, height: 100 }}
                >
                  <LandingIcon name={step.icon} size={ICON_SIZE.step} className="text-white" />
                </div>
                <h5 className="mt-4 mb-3">{step.title}</h5>
                <p className="mb-0">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
