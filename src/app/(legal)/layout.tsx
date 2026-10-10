import Link from "next/link";
import type { Metadata } from "next";

// The legal documents are rendered with the landing page's own stylesheets
// so the two sites read as one product. They are imported from where the
// marketing route group keeps them rather than copied, so a palette change
// in one place moves both.
import "../(marketing)/template/bootstrap.min.css";
import "../(marketing)/template/animate.min.css";
import "../(marketing)/template/style.css";

import { LANDING_BRAND, LANDING_NAV } from "@/lib/marketing/landing-content";
import { LEGAL_DOCUMENTS } from "@/lib/marketing/legal-content";

/**
 * Shell for the public legal documents (/terms, /privacy).
 *
 * Deliberately its own route group instead of a child of (marketing): the
 * marketing layout carries the hero, the scroll-spy navbar whose links are
 * in-page anchors (#features, #pricing) and the reveal-on-scroll wrapper —
 * none of which exist on a document page, and an anchor that has no target
 * is exactly the kind of dead link the landing brief forbids. This bar
 * links to /#features and /#pricing instead, which resolve from anywhere.
 *
 * Every trip out of here is a plain <a>, not next/link, so the landing
 * page's Bootstrap never travels with the visitor into the app. The two
 * exceptions are the links back to the landing page itself, which loads
 * exactly the same stylesheets — there they are a client-side navigation,
 * and next/link is what the project's lint rules ask for.
 */
/** No title here on purpose: each document sets its own, and the root
 *  layout's "%s — Ashwini Innovations" template turns it into
 *  "Terms of Service — Ashwini Innovations". */
export const metadata: Metadata = {
  description: `The ${LANDING_BRAND.name} terms of service and privacy policy.`,
  icons: {
    icon: [{ url: LANDING_BRAND.logoSrc, type: "image/jpeg" }],
  },
};

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="container-fluid bg-white p-0">
      <header className="navbar navbar-expand navbar-light legal-bar px-4 px-lg-5 py-3">
        <Link
          href="/"
          className="navbar-brand p-0 d-flex align-items-center gap-2"
          aria-label={`${LANDING_BRAND.name} — home`}
        >
          <img src={LANDING_BRAND.logoSrc} alt="" width={45} height={45} />
          <span className="fs-5 fw-bold text-white">{LANDING_BRAND.name}</span>
        </Link>

        <nav className="navbar-nav mx-auto" aria-label="Marketing">
          {LANDING_NAV.map((link) => (
            <a key={link.hash} href={`/#${link.hash}`} className="nav-item nav-link py-2 py-lg-0">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="d-flex flex-wrap align-items-center gap-2">
          <a href={LANDING_BRAND.loginHref} className="btn btn-on-dark-outline rounded-pill py-2 px-4">
            Log in
          </a>
          <a href={LANDING_BRAND.signupHref} className="btn btn-on-dark rounded-pill py-2 px-4">
            Start free trial
          </a>
        </div>
      </header>

      <main>{children}</main>

      <div className="container-fluid legal-footer">
        <div className="container-xxl px-lg-5">
          <div className="row g-3 align-items-center">
            <div className="col-md-6 text-center text-md-start">
              © 2026 {LANDING_BRAND.name}
            </div>
            <div className="col-md-6 text-center text-md-end">
              {LEGAL_DOCUMENTS.map((document) => (
                <a key={document.slug} href={`/${document.slug}`} className="me-3">
                  {document.title}
                </a>
              ))}
              <Link href="/">Home</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
