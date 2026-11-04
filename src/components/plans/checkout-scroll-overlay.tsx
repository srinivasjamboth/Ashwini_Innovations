'use client';

// ============================================================
// CheckoutScrollOverlay — the pricing section's "Billing" tab.
//
// What it replaces: clicking Subscribe used to navigate away from the pricing
// grid to `/checkout`. Now the very same billing UI (<CheckoutPanel>, one copy
// shared with that route) opens in place, framed by the Aceternity
// ContainerScroll motion.
//
// THE DESIGN IS THE PUBLISHED ONE, ON PURPOSE: the dark 4px frame, the 30px
// radius, the picture-frame drop shadow, the title sitting above the card and
// the back/close row above that. A short-lived variant of this file stripped
// the frame for a flush bottom sheet; the owner asked for the framed look
// back, so the frame is the design here and `Card` is used with its own
// defaults. Only three overrides remain, and each has a reason:
//   · `mt-0` — the published card carries `-mt-12` to overlap the header. In a
//     scroll section that reads as depth; here it painted the plan title
//     *behind* the card border, so the overlap has to go.
//   · content height + inner scroll — a fixed 30/40rem frame clips a payment
//     form. The card takes ALL the height the viewport leaves (flexbox
//     measures it; a hand-tuned `max-h` calc was smaller than the real chrome
//     above and below it, which is what pushed the tab's bottom off screen) and
//     scrolls inside the frame, so it is tall and centred at any plan length.
//   · `slide` — the travel below, see next paragraph.
//
// THE MOTION: the tab starts BELOW the bottom edge of the viewport and glides
// up while it leans back, straightening into its resting position, with the
// title parallaxing a few pixels behind it and the whole frame fading in.
// Travel is the point: the published effect is a tilt driven by page scroll,
// and a tilt alone is invisible at both ends of a modal transition. Two
// numbers used to hide it — a fixed 340px travel on a ~90dvh tab (already most
// of the way up at frame one, so nothing appeared to arrive) and an expo-out
// ease that measured 49% of its distance inside the first 70ms of 700ms (a
// snap, not a glide). Both are fixed: viewport-relative travel, and a
// cubic-out curve, which measures 28% over the same 70ms.
//
// Why a portal: the landing's sections are wrapped in transform-based reveal
// animations (LandingMotion + animate.css). Any transformed ancestor becomes
// the containing block for `position: fixed`, so a fixed layer rendered
// inside the pricing grid would be positioned against that section, not the
// viewport. document.body has no such ancestor.
//
// Backend: untouched. No API route, no price, no cycle rule and no payment
// call lives here — <CheckoutPanel> owns all of it, and `/checkout?plan=&cycle=`
// still serves the same thing for middle-click, shared links, no-JS and the
// post-login redirect.
// ============================================================

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'framer-motion';
import { ArrowLeft, X } from 'lucide-react';

import { Card, Header } from '@/components/ui/container-scroll-animation';
import { CheckoutPanel } from '@/components/plans/checkout-panel';

export interface CheckoutScrollOverlayProps {
  planId: string | null;
  cycle: 'monthly' | 'yearly';
  /** Plan name for the header, when the caller already knows it (the card
   *  it came from does). The panel re-reads the catalog for everything
   *  that matters, so this is decoration only. */
  planName?: string | null;
  onClose: () => void;
}

// Published Aceternity geometry, kept as the author set it: 20° of tilt and
// the 1.05 / 0.7 scale pair, mobile included.
const TILT_DEGREES = 20;
const HEADER_LIFT_PX = 60;
// The travel. The tab rests with roughly 11dvh of chrome above it, so 85dvh of
// travel puts it clear of the viewport at frame one — while staying small
// enough that the movement is visible from the very first frame instead of
// arriving late after a long off-screen flight. Viewport units, because the
// distance has to mean "one screen" on a laptop and on a phone alike.
const RISE_TRAVEL = '85dvh';
const ENTER_DURATION = 0.7;
const EXIT_DURATION = 0.45;
// easeOutCubic in / easeInCubic out: the distance is spread across the whole
// duration instead of being front-loaded, which is what makes a long travel
// read as a glide rather than a snap.
const EASE_OUT: [number, number, number, number] = [0.215, 0.61, 0.355, 1];
const EASE_IN: [number, number, number, number] = [0.55, 0.06, 0.68, 0.19];

export function CheckoutScrollOverlay({
  planId,
  cycle,
  planName,
  onClose,
}: CheckoutScrollOverlayProps) {
  const titleId = useId();
  const layerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);
  const prefersReducedMotion = useReducedMotion();

  // Scroll-driven in the published component; here it is driven by the
  // open/close transition instead, because the tab must END straight and
  // readable — a payment form cannot sit at a tilt waiting for a scroll that a
  // modal has no reason to make. 0 = below/leaning/entering, 1 = at rest.
  const progress = useMotionValue(0);
  const backdropOpacity = useMotionValue(0);
  const frameOpacity = useMotionValue(0);
  const rotate = useTransform(progress, [0, 1], [TILT_DEGREES, 0]);
  const rise = useTransform(progress, [0, 1], [RISE_TRAVEL, '0dvh']);
  const headerLift = useTransform(progress, [0, 1], [HEADER_LIFT_PX, 0]);

  // The published mobile sizing, mirrored from <ContainerScroll>.
  const [isMobile, setIsMobile] = useState(false);
  const scale = useTransform(
    progress,
    [0, 1],
    isMobile ? [0.7, 0.9] : [1.05, 1]
  );
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const settle = useCallback(() => {
    if (prefersReducedMotion) {
      // No travel, no tilt — but still a fade, so the tab does not appear as a
      // hard cut. An opacity change is not motion and stays within the setting.
      progress.set(1);
      animate(backdropOpacity, 1, { duration: 0.15 });
      animate(frameOpacity, 1, { duration: 0.15 });
      return;
    }
    animate(progress, 1, { duration: ENTER_DURATION, ease: EASE_OUT });
    animate(backdropOpacity, 1, { duration: 0.25 });
    // Fades over the first half of the rise; without it the frame's edge and
    // shadow pop the instant the layer mounts, before it has travelled.
    animate(frameOpacity, 1, { duration: ENTER_DURATION * 0.55 });
  }, [backdropOpacity, frameOpacity, prefersReducedMotion, progress]);

  // Enter as soon as the layer exists, and lock the page behind it for the
  // same lifetime (the pricing grid must not scroll under the panel).
  useEffect(() => {
    const body = document.body;
    const previousOverflow = body.style.overflow;
    // Compensate the scrollbar the lock removes, or the centred pricing row
    // shifts sideways the moment the panel opens.
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    settle();
    // Focus lands on the close control: keyboard and screen-reader users get
    // the way out as the first thing they can act on.
    const focusTimer = window.setTimeout(
      () => closeButtonRef.current?.focus(),
      60
    );

    return () => {
      window.clearTimeout(focusTimer);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = '';
    };
  }, [settle]);

  const requestClose = useCallback(() => {
    // Guard the exit animation against a second backdrop click / repeated
    // Escape arriving while it still plays.
    if (closingRef.current) return;
    closingRef.current = true;
    if (prefersReducedMotion) {
      onClose();
      return;
    }
    // The entrance in reverse: the tab leans, drops back down and fades.
    animate(progress, 0, { duration: EXIT_DURATION, ease: EASE_IN });
    animate(backdropOpacity, 0, { duration: EXIT_DURATION - 0.12 });
    animate(frameOpacity, 0, { duration: EXIT_DURATION - 0.12 });
    window.setTimeout(onClose, EXIT_DURATION * 1000 + 40);
  }, [backdropOpacity, frameOpacity, onClose, prefersReducedMotion, progress]);

  // Escape works even if focus somehow left the layer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  // Keep Tab inside the panel while it is open — it holds a pay button, so
  // the page behind it must not be reachable.
  const trapFocus = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Tab') return;
      const nodes = layerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    []
  );

  return createPortal(
    /* Centred, and clipped (`overflow-hidden`) for the whole lifetime: the tab
       travels below the viewport on its way in, and a transform extends the
       scrollable area, so a scrollable layer would flash a scrollbar and shift
       the tab sideways mid-entrance. Nothing overflows at rest because the
       card is flex-sized to the space that is actually left. */
    <div
      ref={layerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={trapFocus}
      className="fixed inset-0 z-[2000] flex flex-col items-center overflow-hidden px-3 pt-3 pb-2 md:px-8 md:pt-4 md:pb-2"
    >
      {/* Click-away layer, painted under everything the tab owns. */}
      <motion.div
        style={{ opacity: backdropOpacity }}
        onClick={requestClose}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm"
        aria-hidden
      />

      {/* Back / close row — the tab's only navigation out, and it stays
          visible for the whole entrance. `shrink-0`: it is chrome, so the
          card absorbs every pixel of height the viewport withholds. */}
      <div className="relative z-10 flex w-full max-w-6xl shrink-0 items-center justify-between gap-3 pb-1">
        <button
          type="button"
          onClick={requestClose}
          className="btn btn-outline-light rounded-pill d-inline-flex align-items-center gap-2 px-3 py-1.5 text-white"
          style={{ fontSize: 14, fontWeight: 500 }}
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to pricing
        </button>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={requestClose}
          aria-label="Close billing"
          className="btn btn-outline-light rounded-circle d-inline-flex align-items-center justify-content-center text-white"
          style={{ width: 38, height: 38 }}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {/* The perspective frame the published component expects. `rise` and the
          fade live on this wrapper so the title and the card travel as one
          tab, which is what the owner described as coming "from down".
          `flex-1 min-h-0` claims the space under the close row and hands it to
          the card, and `min-h-0` is what lets the card shrink (and scroll
          inside) instead of overflowing. */}
      <motion.div
        className="relative z-10 flex min-h-0 w-full max-w-6xl flex-1 flex-col items-center pt-1 pb-1 md:pt-2 md:pb-2"
        style={{ perspective: '1000px', opacity: frameOpacity }}
      >
        <Header
          translate={headerLift}
          className="mx-auto mb-3 max-w-4xl shrink-0 text-center md:mb-4"
          titleComponent={
            <>
              <p
                className="text-primary-gradient fw-medium mb-1"
                style={{ letterSpacing: 0.4, color: '#fff', opacity: 0.75 }}
              >
                Billing
              </p>
              <h2
                id={titleId}
                className="mb-0 text-white"
                style={{
                  fontWeight: 700,
                  fontSize: 'clamp(1.5rem, 3.4vw, 2.5rem)',
                }}
              >
                {planName ? `${planName} · ` : ''}
                <span className="text-white-50">
                  {cycle === 'yearly' ? 'Yearly' : 'Monthly'}
                </span>
              </h2>
            </>
          }
        />
        <Card
          rotate={rotate}
          scale={scale}
          slide={rise}
          // Frame, radius, border, dark surface and drop shadow are the
          // published ones — nothing is overridden here but the overlap and
          // the height. `flex-1` is the height: the card takes ALL the space
          // the frame has left after the close row and the title, so the tab
          // is as tall as the viewport allows instead of shrink-wrapping the
          // plan; `min-h-0` keeps that shrinkable, and the inner surface
          // (`flex-1 min-h-0 overflow-auto`) scrolls whatever does not fit.
          // `bg-white` in both themes keeps the Bootstrap billing text at the
          // contrast it has on /checkout, inside the dark frame.
          className="mt-0 flex h-auto min-h-0 flex-1 flex-col md:h-auto"
          innerClassName="h-auto min-h-0 flex-1 overflow-auto p-4 md:p-5 bg-white dark:bg-white"
        >
          <CheckoutPanel
            planId={planId}
            cycle={cycle}
            onBackToPricing={requestClose}
            className="row g-4 g-lg-5 align-items-start"
          />
        </Card>
      </motion.div>
    </div>,
    document.body
  );
}
