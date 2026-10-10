import type { Metadata } from "next";

import "./template/bootstrap.min.css";
import "./template/animate.min.css";
import "./template/style.css";

import { LandingBackToTop } from "@/components/marketing/landing-back-to-top";
import { LandingFooter } from "@/components/marketing/landing-footer";
import { LandingHeader } from "@/components/marketing/landing-header";
import { LandingMotion } from "@/components/marketing/landing-motion";
import { LANDING_BRAND } from "@/lib/marketing/landing-content";

/**
 * Marketing shell — the public landing page, built from the template in
 * `landing page/` (Bootstrap 5 grid + its stylesheet + the animated
 * sections) rather than a new design.
 *
 * Nesting follows the template's own DOM, because its CSS depends on it:
 *   container-fluid.bg-white.p-0          the white page frame, full window
 *     container-fluid.position-relative.p-0
 *                                         the frame the navbar anchors to
 *       navbar  +  hero                   .navbar-light is position:absolute
 *                                         above 992px, so it has to sit in
 *                                         the same relative box as the hero
 *                                         it overlays
 *       …sections…
 *     footer, back-to-top
 *
 * The frame is full-bleed, not the template's own `container-xxl`: that
 * class stops at 1400px, so on a wide window the whole page — hero
 * gradient and all — sat in a narrow centred column with empty gutters.
 * Each band now runs edge to edge and the readable column is the
 * `container-xxl` inside it, which is how the template's own footer was
 * already built.
 *
 * The stylesheet order is load-bearing: Bootstrap first, then animate.css
 * (the keyframes the reveal-on-scroll wrapper triggers), then the
 * template's style.css, whose palette and overrides must win. Tailwind's
 * own base layer is in a CSS `@layer`, so these plain rules always beat
 * it on this route and never reach the dashboard, where this layout is
 * not mounted.
 *
 * Fonts: the template asked Google Fonts for Heebo + Jost and two icon
 * fonts from CDNs (Font Awesome 5, Bootstrap Icons). All four requests are
 * gone — the page inherits Inter from the root layout, as the brief asked,
 * and every glyph is a bundled SVG (components/marketing/landing-icons.tsx)
 * in the same gradient circles the theme designed. Nothing on this page
 * depends on a font CDN answering.
 */
export const metadata: Metadata = {
  title: { absolute: LANDING_BRAND.name },
  description:
    "Ashwini Innovations puts your WhatsApp Business number in one shared workspace — inbox, contacts, pipelines, broadcasts, automations and flows for the whole team.",
  icons: {
    // Same asset the root layout uses for the favicon.
    icon: [{ url: "/logo.jpeg", type: "image/jpeg" }],
  },
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <LandingMotion>
      {/* Preloader — the template's own, faded out on mount. */}
      <div
        id="spinner"
        className="show bg-white position-fixed translate-middle w-100 vh-100 top-50 start-50 d-flex align-items-center justify-content-center"
      >
        <div
          className="spinner-grow text-primary"
          style={{ width: "3rem", height: "3rem" }}
          role="status"
        >
          <span className="visually-hidden">Loading…</span>
        </div>
      </div>

      <noscript>
        <link rel="stylesheet" href="/landing/noscript.css" />
      </noscript>

      <div className="container-fluid bg-white p-0">
        <div className="container-fluid position-relative p-0">
          <LandingHeader />
          <main>{children}</main>
        </div>
        <LandingFooter />
        <LandingBackToTop />
      </div>
    </LandingMotion>
  );
}
