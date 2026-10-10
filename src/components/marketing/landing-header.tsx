"use client";

/**
 * Navbar — the template's navbar, in the template's markup.
 *
 * Bootstrap classes and the theme's own treatment are kept: the
 * transparent bar that sits over the hero (`.navbar-light` is
 * `position: absolute` above 992px), the triangle indicator that drops
 * down under a nav link on hover/active (::before in template/style.css),
 * the shrink to `sticky-top shadow-sm` after 45px of scroll, and the
 * brand image that reduces from 60px to 45px when the bar sticks.
 *
 * The jQuery in js/main.js did two things here, reimplemented without
 * adding jQuery or Bootstrap's JS bundle to the app:
 *   - the sticky class toggle        -> a scroll listener + `stuck`
 *   - smooth scroll with a -45 offset-> scrollToSection + `.anchor`
 *     scroll-margin-top, which is the CSS equivalent of that offset
 * Scrollspy (`data-bs-spy="scroll"` on <body>) is reproduced with an
 * IntersectionObserver so the active arrow still tracks the section.
 *
 * `navbar-expand` (no breakpoint infix) is deliberate: it is Bootstrap's
 * always-expanded variant, so Home / Features / Pricing and the two
 * buttons are in the horizontal bar at every width and there is no
 * hamburger at all. Below 992px the bar is allowed to wrap onto a second
 * line and the type tightens — see the navbar block in template/style.css.
 */

import { useCallback, useEffect, useState, type MouseEvent } from "react";

import { scrollToSection } from "@/components/marketing/landing-anchor-link";
import {
  LANDING_BRAND,
  LANDING_NAV,
  type LandingNavLink,
} from "@/lib/marketing/landing-content";

export function LandingHeader() {
  const [stuck, setStuck] = useState(false);
  const [active, setActive] = useState("home");

  // The template flips the bar at 45px of scroll.
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 45);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // data-bs-spy replacement: the last section whose top passed the bar.
  useEffect(() => {
    const sections = LANDING_NAV.map((link) => document.getElementById(link.hash)).filter(
      (el): el is HTMLElement => el !== null,
    );
    if (sections.length === 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const onNavClick = useCallback(
    (link: LandingNavLink, event: MouseEvent<HTMLAnchorElement>) => {
      // Keep it a real href (right-click, middle-click, no-JS jump all
      // still work) — only a plain left click gets the animation.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setActive(link.hash);
      scrollToSection(link.hash);
      window.history.replaceState(null, "", `#${link.hash}`);
    },
    [],
  );

  /** The five items that make up the bar; every width shows all of them. */
  const navLinks = () =>
    LANDING_NAV.map((link) => (
      <a
        key={link.hash}
        href={`#${link.hash}`}
        className={`nav-item nav-link ${active === link.hash ? "active" : ""}`}
        onClick={(event) => onNavClick(link, event)}
      >
        {link.label}
      </a>
    ));

  return (
    <nav
      className={`navbar navbar-expand navbar-light px-4 px-lg-5 ${
        stuck ? "sticky-top shadow-sm" : "py-3 py-lg-0"
      }`}
      aria-label="Main"
    >
      <a
        href="#home"
        className="navbar-brand p-0 d-flex align-items-center gap-2"
        onClick={(event) => onNavClick({ label: "Home", hash: "home" }, event)}
        aria-label={`${LANDING_BRAND.name} — back to top`}
      >
        {/* The template ships this slot as a commented-out <img> next to
            the wordmark; ours is the same logo the dashboard and the
            favicon already use. */}
        <img src={LANDING_BRAND.logoSrc} alt="" width={45} height={45} />
        {/* The bar is transparent over the dark hero, then turns white when
            it sticks — the wordmark has to follow that swap or it disappears
            into whichever surface it is not sized for. */}
        <span className={`fs-5 fw-bold ${stuck ? "text-dark" : "text-white"}`}>
          {LANDING_BRAND.name}
        </span>
      </a>

      <div className="navbar-collapse" id="navbarCollapse">
        <div className="navbar-nav mx-auto py-0">{navLinks()}</div>
        <div className="d-flex flex-wrap align-items-center gap-2 py-3 py-lg-0">
          {/* Plain anchors, not next/link: this route carries Bootstrap and
              the template sheet, and a full document load for the trip into
              the app guarantees those rules never travel with the visitor.
              Both buttons invert while the bar is transparent over the dark
              hero, and go back to the theme's blue pills on the white bar. */}
          <a
            href={LANDING_BRAND.loginHref}
            className={`btn rounded-pill py-2 px-4 ${
              stuck ? "btn-outline-blue" : "btn-on-dark-outline"
            }`}
          >
            Log in
          </a>
          <a
            href={LANDING_BRAND.signupHref}
            className={`btn rounded-pill py-2 px-4 ms-lg-3 ${
              stuck ? "btn-primary-gradient" : "btn-on-dark"
            }`}
          >
            Start free trial
          </a>
        </div>
      </div>
    </nav>
  );
}
