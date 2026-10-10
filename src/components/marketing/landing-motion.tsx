"use client";

/**
 * Reveal-on-scroll — the React equivalent of the template's wow.js.
 *
 * The markup carries the template's own classes (`class="wow fadeInUp"
 * data-wow-delay="0.1s"`, exactly as index.html wrote them) and animate.css
 * supplies the keyframes. wow.js did two things with them, and this does
 * the same two things: hide every `.wow` box (template/style.css), then
 * add `.animated` to a box once it scrolls into view so its entrance
 * plays, honouring the delay the markup asks for. Nothing is imported
 * from the template's JS files.
 *
 * Two safety rules, both handled in template/style.css as well:
 * visitors who prefer reduced motion and browsers without
 * IntersectionObserver get the content shown immediately, and a
 * <noscript> fallback keeps the page readable with JS off.
 */

import { useEffect, type ReactNode } from "react";

export function LandingMotion({ children }: { children: ReactNode }) {
  useEffect(() => {
    // The template's preloader: a full-screen white panel with a growing
    // spinner that js/main.js hid one millisecond after load. Same here —
    // drop .show and the CSS fades it out.
    document.getElementById("spinner")?.classList.remove("show");

    const boxes = Array.from(document.querySelectorAll<HTMLElement>(".wow"));
    if (boxes.length === 0) return;

    const showImmediately = () => {
      for (const box of boxes) box.style.visibility = "visible";
    };

    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      showImmediately();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          // animate.css already has the effect name in the class list;
          // `.animated` is the switch that makes it run.
          entry.target.classList.add("animated");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -60px 0px", threshold: 0.01 },
    );

    for (const box of boxes) {
      if (box.dataset.wowDelay) box.style.animationDelay = box.dataset.wowDelay;
      observer.observe(box);
    }

    return () => observer.disconnect();
  }, []);

  return <>{children}</>;
}
