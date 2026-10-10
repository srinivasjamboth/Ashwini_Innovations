"use client";

/**
 * Footer — the template's footer shell kept: the `bg-primary text-light
 * footer` panel with the decorative circle / triangle / top PNGs painted
 * behind its blue gradient, `.btn.btn-link` entries with the theme's
 * chevron, and the bordered copyright bar with an inline `.footer-menu`.
 *
 * Four columns, the template's own grid: the brand and a one-line
 * description, Contact Us (the operator's real email, phone and location,
 * where the template had "123 Street, New York, USA / +012 345 67890 /
 * info@example.com"), Quick Link, and Legal. Removed outright, because
 * none of it was ours or real: the four social buttons (all `href=""`),
 * the second link column whose five entries pointed at `href=""`, the
 * "Newsletter" column (its filler paragraph and its email input with a
 * paper-plane submit button), the "Your Site Name" placeholder and the
 * vendor's own credit links in the copyright line.
 *
 * The three nav entries smooth-scroll like the navbar's. Terms of Service
 * and Privacy Policy are shown as plain text for one reason: neither page
 * exists in this app yet, and a footer link has to resolve — they turn
 * into links the day the routes do.
 */

import { LandingAnchorLink } from "@/components/marketing/landing-anchor-link";
import { LandingIcon, ICON_SIZE } from "@/components/marketing/landing-icons";
import {
  LANDING_BRAND,
  LANDING_CONTACT,
  LANDING_FOOTER,
  LANDING_LEGAL,
} from "@/lib/marketing/landing-content";

export function LandingFooter() {
  return (
    <div className="container-fluid bg-primary text-light footer wow fadeIn" data-wow-delay="0.1s">
      <div className="container-xxl py-5 px-lg-5">
        <div className="row g-5">
          <div className="col-md-6 col-lg-4">
            <div className="d-flex align-items-center mb-4">
              <img
                src={LANDING_BRAND.logoSrc}
                alt=""
                width={44}
                height={44}
                className="rounded"
              />
              <h4 className="text-white mb-0 ms-3">{LANDING_BRAND.name}</h4>
            </div>
            <p className="mb-0">{LANDING_FOOTER.blurb}</p>
          </div>

          <div className="col-md-6 col-lg-4">
            <h4 className="text-white mb-4">{LANDING_CONTACT.eyebrow}</h4>
            <p className="mb-2">{LANDING_CONTACT.email.note}</p>
            <p className="footer-detail">
              <LandingIcon name="fa-envelope" size={ICON_SIZE.inline} className="me-2" />
              <a href={LANDING_CONTACT.email.href}>{LANDING_CONTACT.email.value}</a>
            </p>
            <p className="footer-detail">
              <LandingIcon name="fa-phone-alt" size={ICON_SIZE.inline} className="me-2" />
              <a href={LANDING_CONTACT.phone.href}>{LANDING_CONTACT.phone.value}</a>
            </p>
            <p className="footer-detail mb-0">
              <LandingIcon name="fa-map-marker-alt" size={ICON_SIZE.inline} className="me-2" />
              <span>
                {LANDING_CONTACT.location.name}, {LANDING_CONTACT.location.country}
              </span>
            </p>
          </div>

          <div className="col-md-6 col-lg-2">
            <h4 className="text-white mb-4">Quick Link</h4>
            {LANDING_FOOTER.links.map((link) => (
              <LandingAnchorLink key={link.hash} hash={link.hash} className="btn btn-link">
                {link.label}
              </LandingAnchorLink>
            ))}
          </div>

          <div className="col-md-6 col-lg-2">
            <h4 className="text-white mb-4">{LANDING_LEGAL.eyebrow}</h4>
            {LANDING_LEGAL.items.map((item) => (
              <a key={item.href} href={item.href} className="footer-plain">
                {item.label}
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="container-xxl px-lg-5">
        <div className="copyright">
          <div className="row">
            <div className="col-md-6 text-center text-md-start mb-3 mb-md-0">
              {LANDING_FOOTER.copyright}
            </div>
            <div className="col-md-6 text-center text-md-end">
              <div className="footer-menu">
                {/* Plain anchors — see the note in landing-header. */}
                <a href={LANDING_BRAND.loginHref}>Log in</a>
                <a href={LANDING_BRAND.signupHref}>Start free trial</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
