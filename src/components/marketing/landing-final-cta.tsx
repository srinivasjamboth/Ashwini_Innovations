import { LANDING_FINAL_CTA } from "@/lib/marketing/landing-content";

/**
 * Final CTA band.
 *
 * Built from the template's own pieces rather than a new design: a
 * rounded panel carrying the theme's dark blue gradient (`.cta-band` in
 * template/style.css), the eyebrow + headline rhythm every other section
 * uses, and the theme's pill buttons — a solid white pill for the primary
 * and a white outline for the secondary. White copy on that panel runs
 * from 16.4:1 at its darkest stop to 7.2:1 at its lightest, so the whole
 * band holds AA.
 *
 * The template had a "Download Our App" band in this slot, with App
 * Store / Play Store badges pointing at `href=""`. There is no client
 * to install, so the band asks for the one action the product can take.
 */
export function LandingFinalCta() {
  return (
    <div className="container-fluid py-5">
      <div className="container-xxl px-lg-5">
        <div className="cta-band rounded p-5 p-lg-4 text-center text-lg-start wow fadeInUp" data-wow-delay="0.1s">
          <div className="row g-4 align-items-center py-3">
            <div className="col-lg-8">
              {/* Not .text-white-50: 50% white on the gradient falls under
                  AA, and an eyebrow is still text. */}
              <h5 className="text-white fw-medium mb-2">{LANDING_FINAL_CTA.eyebrow}</h5>
              <h1 className="text-white mb-3">{LANDING_FINAL_CTA.headline}</h1>
              <p className="text-white mb-0">{LANDING_FINAL_CTA.body}</p>
            </div>
            <div className="col-lg-4 text-lg-end">
              {/* Plain anchors — see the note in landing-header. */}
              <a
                href={LANDING_FINAL_CTA.primaryCta.href}
                className="btn btn-light rounded-pill py-sm-3 px-4 px-sm-5 me-lg-0 mb-3 mb-lg-0 d-block d-lg-inline-block"
              >
                {LANDING_FINAL_CTA.primaryCta.label}
              </a>
              <a
                href={LANDING_FINAL_CTA.secondaryCta.href}
                className="btn btn-outline-light rounded-pill py-sm-3 px-4 px-sm-5 ms-lg-3 mt-3 mt-lg-0 d-block d-lg-inline-block"
              >
                {LANDING_FINAL_CTA.secondaryCta.label}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
