"use client";

/**
 * Back to top — the template's fixed gradient circle in the bottom right
 * (`.back-to-top` in template/style.css), shown past 100px of scroll the
 * way js/main.js did it with fadeIn/fadeOut, and scrolling to the top on
 * click. Its icon was Bootstrap Icons' arrow-up, then the template's Font
 * Awesome set; both are CDN fonts, so it now uses the bundled glyph from
 * landing-icons and the page asks nothing of a font CDN.
 *
 * The `href="#home"` is the no-JS fallback — the template's was `href="#"`.
 */

import { useCallback, useEffect, useState, type MouseEvent } from "react";

import { scrollToSection } from "@/components/marketing/landing-anchor-link";
import { LandingIcon, ICON_SIZE } from "@/components/marketing/landing-icons";

export function LandingBackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 100);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const onClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    scrollToSection("home");
    // Drop the #home the fallback link would have left in the URL.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  return (
    <a
      href="#home"
      className={`btn btn-lg btn-lg-square back-to-top pt-2 ${visible ? "show" : ""}`}
      onClick={onClick}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
    >
      <LandingIcon name="fa-arrow-up" size={ICON_SIZE.small} className="text-white" />
      <span className="visually-hidden">Back to top</span>
    </a>
  );
}
