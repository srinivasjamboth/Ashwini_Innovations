import type { Metadata } from "next";

// Same Bootstrap + template stylesheet the landing uses, imported by path so
// the checkout shares the brand's palette, buttons and grid WITHOUT dragging
// in the landing's chrome (its transparent hero navbar, animated sections and
// full marketing footer). Those live in the (marketing) layout, which this
// route deliberately does NOT sit under.
import "../(marketing)/template/bootstrap.min.css";
import "../(marketing)/template/style.css";

import Link from "next/link";

import { LANDING_BRAND } from "@/lib/marketing/landing-content";

/**
 * Checkout chrome — a focused, minimal frame for the public billing page.
 *
 * A subscription page is not a marketing page: the header carries the brand
 * only (no Home / Features / Pricing, no hero overlay), the body is a single
 * centred column, and the footer is one quiet line (Terms / Privacy). This is
 * the conventional, distraction-free layout the well-known SaaS checkouts use,
 * and it keeps the visitor's attention on the one action — paying.
 *
 * The landing keeps its own elaborate layout untouched; only `/checkout`
 * renders inside this frame.
 */
export const metadata: Metadata = {
  title: { absolute: `Checkout — ${LANDING_BRAND.name}` },
  description:
    "Complete your Ashwini Innovations subscription securely — review your plan and pay online.",
  // A checkout page is never search content; keep it out of indexes.
  robots: { index: false, follow: false },
};

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="container-fluid bg-white p-0 min-vh-100 d-flex flex-column">
      {/* Brand-only header: solid, hairline-ruled, dark wordmark on white. */}
      <header className="border-bottom bg-white">
        <div className="container-xxl px-4 px-lg-5 d-flex align-items-center" style={{ height: 68 }}>
          <Link
            href="/"
            className="d-inline-flex align-items-center gap-2 text-decoration-none"
            aria-label={`${LANDING_BRAND.name} — home`}
          >
            <img src={LANDING_BRAND.logoSrc} alt="" width={38} height={38} className="rounded" />
            <span className="fs-5 fw-bold text-dark">{LANDING_BRAND.name}</span>
          </Link>
        </div>
      </header>

      <main className="flex-grow-1">{children}</main>

      <footer className="border-top bg-white">
        <div className="container-xxl px-4 px-lg-5 py-4 d-flex flex-wrap align-items-center justify-content-between gap-2">
          <span className="text-muted" style={{ fontSize: 13 }}>
            © 2026 {LANDING_BRAND.name}
          </span>
          <span className="d-flex align-items-center gap-4">
            <Link href="/terms" className="text-muted text-decoration-none" style={{ fontSize: 13 }}>
              Terms
            </Link>
            <Link href="/privacy" className="text-muted text-decoration-none" style={{ fontSize: 13 }}>
              Privacy
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
