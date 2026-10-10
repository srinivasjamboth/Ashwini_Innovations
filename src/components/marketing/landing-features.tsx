import { LandingIcon } from "@/components/marketing/landing-icons";
import { LANDING_FEATURES, LANDING_FEATURES_HEADLINE } from "@/lib/marketing/landing-content";

/**
 * Features — the template's feature grid, unchanged in structure: the
 * centred eyebrow + headline, then `row g-4` cards at col-lg-4 col-md-6,
 * each with a 60px gradient circle holding a glyph, an h5 title and a
 * one-line description. The `.feature-item` hover lift
 * (margin-top -15px + shadow) and the staggered fadeInUp per column come
 * from the theme's own CSS.
 *
 * The template's six cards were generic app-mall copy ("High
 * Resolution", "Retina Ready", "Cloud Storage") over filler text, so the
 * titles and descriptions now describe the modules this product has.
 * Their "Read More" links pointed at nothing; there are none.
 */
export function LandingFeatures() {
  return (
    <div className="container-fluid py-5 anchor" id="features">
      <div className="container-xxl py-5 px-lg-5">
        <div className="text-center wow fadeInUp" data-wow-delay="0.1s">
          <h5 className="text-primary-gradient fw-medium">{LANDING_FEATURES_HEADLINE.eyebrow}</h5>
          <h1 className="mb-5">{LANDING_FEATURES_HEADLINE.headline}</h1>
        </div>
        <div className="row g-4">
          {LANDING_FEATURES.map((feature, i) => (
            <div
              key={feature.title}
              className="col-lg-4 col-md-6 wow fadeInUp"
              // the theme cycles 0.1s / 0.3s / 0.5s across a row
              data-wow-delay={`${0.1 + (i % 3) * 0.2}s`}
            >
              <div className="feature-item bg-light rounded p-4 h-100">
                <div
                  className={`d-inline-flex align-items-center justify-content-center bg-${feature.tone}-gradient rounded-circle mb-4`}
                  style={{ width: 60, height: 60 }}
                >
                  <LandingIcon name={feature.icon} className="text-white" />
                </div>
                <h5 className="mb-3">{feature.title}</h5>
                <p className="m-0">{feature.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
