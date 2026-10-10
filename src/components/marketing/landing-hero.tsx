"use client";

/**
 * Hero — the template's hero, same grid, same animated headline, same
 * phone-mockup carousel on the right.
 *
 * What stayed: the hero band with its decorative circle/triangle/bottom
 * PNGs over the gradient, the 8/4 column split, the `animated slideInDown
 * / slideInLeft / slideInRight` entrances that the theme runs on load, and
 * the owl-carousel markup the theme styles (`.screenshot-carousel` with
 * its frame PNG and vertical dots). The band is `container-fluid` so the
 * gradient fills the window; the copy stays in a `container-xxl` column.
 *
 * What changed: the background is the dark blue gradient, so the headline
 * and paragraph are the template's own white, and the two buttons use the
 * inverted white pills that a dark band needs; "Read More" became "Start
 * free trial", and the second button was a "Contact Us" that opened the
 * contact form, and is now "Log in".
 *
 * The carousel ran on owl.carousel.min.js (autoplay, loop, dots, 1
 * item). It is reimplemented with a timer and the same class names, so
 * the theme's dot styling and the phone frame overlay are untouched.
 */

import { useCallback, useEffect, useState } from "react";

import { LANDING_HERO } from "@/lib/marketing/landing-content";

/** owl's default autoplay timeout, in ms. */
const AUTOPLAY_MS = 5000;

export function LandingHero() {
  const slides = LANDING_HERO.screenshots;
  const [index, setIndex] = useState(0);

  const goTo = useCallback((next: number) => setIndex(((next + slides.length) % slides.length)), [slides.length]);

  useEffect(() => {
    // Reduced motion keeps the carousel static on the first screenshot.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % slides.length), AUTOPLAY_MS);
    return () => window.clearInterval(timer);
  }, [slides.length]);

  return (
    <div className="container-fluid bg-primary hero-header anchor" id="home">
      <div className="container-xxl px-lg-5">
        <div className="row g-5">
          <div className="col-lg-8 text-center text-lg-start">
            <h1 className="hero-title mb-4 animated slideInDown">{LANDING_HERO.headline}</h1>
            <p className="hero-lead pb-3 animated slideInDown">{LANDING_HERO.subhead}</p>
            {/* Anchors, not next/link — see the note in landing-header: the
                landing page's CSS must not follow the visitor into the app. */}
            <a
              href={LANDING_HERO.primaryCta.href}
              className="btn btn-on-dark py-sm-3 px-4 px-sm-5 rounded-pill me-3 animated slideInLeft mb-3"
            >
              {LANDING_HERO.primaryCta.label}
            </a>
            <a
              href={LANDING_HERO.secondaryCta.href}
              className="btn btn-on-dark-outline py-sm-3 px-4 px-sm-5 rounded-pill animated slideInRight mb-3"
            >
              {LANDING_HERO.secondaryCta.label}
            </a>
          </div>

          <div className="col-lg-4 d-flex justify-content-center justify-content-lg-end wow fadeInUp" data-wow-delay="0.3s">
            <div className="owl-carousel screenshot-carousel">
              <div className="owl-stage-outer">
                <div className="owl-stage">
                  {slides.map((shot, i) => (
                    <div key={shot.src} className={`owl-item ${i === index ? "active" : ""}`}>
                      {/* Fixed 223x470 box from the theme's CSS: the frame
                          PNG is painted over it by ::before, so the size
                          must not be fluid or the bezel misaligns. */}
                      <img
                        src={shot.src}
                        alt={shot.alt}
                        width={223}
                        height={470}
                        className="img-fluid"
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div className="owl-dots" role="tablist" aria-label="Screenshots">
                {slides.map((shot, i) => (
                  <button
                    key={shot.src}
                    type="button"
                    role="tab"
                    aria-selected={i === index}
                    aria-label={`Show ${shot.alt}`}
                    className={`owl-dot ${i === index ? "active" : ""}`}
                    onClick={() => goTo(i)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
