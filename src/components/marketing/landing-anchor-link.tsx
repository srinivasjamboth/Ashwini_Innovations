"use client";

/**
 * Smooth-scrolling in-page anchor.
 *
 * `scrollToSection` is the replacement for the jQuery snippet in the
 * template's js/main.js that animated `html, body` to the target with a
 * -45px offset; the offset is now `scroll-margin-top` on the `.anchor`
 * class in template/style.css, which is the CSS equivalent and also
 * covers native (no-JS) anchor jumps.
 *
 * Deliberately no `html { scroll-behavior: smooth }` anywhere: that rule
 * would follow the visitor into the dashboard, where the inbox and several
 * dialogs rely on instant scrollIntoView.
 */

import { useCallback, type MouseEvent, type ReactNode } from "react";

export function scrollToSection(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

interface LandingAnchorLinkProps {
  /** id of the section on the landing page */
  hash: string;
  className?: string;
  children: ReactNode;
  /** Called before scrolling — the collapsed mobile menu uses it. */
  onNavigate?: () => void;
}

export function LandingAnchorLink({
  hash,
  className,
  children,
  onNavigate,
}: LandingAnchorLinkProps) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Modifier clicks keep the browser's default behaviour.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onNavigate?.();
      scrollToSection(hash);
      // Make the section linkable without adding a history entry.
      window.history.replaceState(null, "", `#${hash}`);
    },
    [hash, onNavigate],
  );

  return (
    <a href={`#${hash}`} className={className} onClick={handleClick}>
      {children}
    </a>
  );
}
