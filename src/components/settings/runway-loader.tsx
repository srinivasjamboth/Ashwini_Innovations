"use client";

// ============================================================
// RunwayLoader — airplane-runway progress for the ONE place it is
// used: submitting a template for Meta approval on the Templates page.
//
// Unlike the stock demo (a self-timed 5.5 s loop that restarts), this
// loader is driven by the REAL request state passed in by the caller:
//
//   · phase "running" — the fetch is in flight. The plane rolls toward
//     ROLL_CAP with an exponential ease, so it keeps crawling for as
//     long as the server takes and never pretends to finish.
//   · phase "done"    — the server accepted the template. The plane
//     sprints from wherever it got to up to 100 %, lifts off, and
//     `onDone` fires after the take-off animation — that is when the
//     caller closes the dialog and surfaces the success message.
//   · phase "failed"  — the server rejected it. The plane simply stops
//     where it is; the caller renders the error next to the loader.
//
// The progress fill is the sidebar's dark blue (#002f69 → lighter
// blues), not the demo's red. Surfaces use theme tokens (bg-muted /
// text-foreground / text-muted-foreground) so it reads correctly in
// light and dark mode without the demo's MutationObserver machinery.
//
// A retry must restart the runway from 0 — render a fresh instance
// (e.g. key={attempt}) rather than flipping failed back to running.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

export type RunwayPhase = "running" | "done" | "failed";

/** % the roll eases toward while the request is in flight. */
const ROLL_CAP = 90;
/** ms — exponential time constant of the roll (reaches ~63 % in this long). */
const ROLL_TAU = 4200;
/** ms — the sprint from wherever the roll stopped up to 100 %. */
const SPRINT_MS = 550;
/** ms — take-off fade before onDone fires (caller closes the dialog). */
const TAKEOFF_MS = 900;

/** The sidebar-blue runway fill. */
const TRACK_FILL = "linear-gradient(to right, #002f69, #0b4a9e 55%, #1e63c8)";

function Airplane() {
  return (
    <svg
      className="h-auto w-[52px] sm:w-[72px]"
      viewBox="0 0 72 46"
      fill="none"
      aria-hidden
      style={{
        filter:
          "drop-shadow(0 2px 8px rgba(0,0,0,0.35)) drop-shadow(0 1px 3px rgba(0,0,0,0.2))",
      }}
    >
      <defs>
        <linearGradient id="rl-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="40%" stopColor="#dedede" />
          <stop offset="100%" stopColor="#b4b4b4" />
        </linearGradient>
        <linearGradient id="rl-wing-t" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#d8d8d8" />
          <stop offset="100%" stopColor="#909090" />
        </linearGradient>
        <linearGradient id="rl-wing-b" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#d8d8d8" />
          <stop offset="100%" stopColor="#909090" />
        </linearGradient>
      </defs>

      {/* top wing */}
      <path d="M44,21 L28,21 L8,2 L18,0 Z" fill="url(#rl-wing-t)" />
      {/* bottom wing */}
      <path d="M44,25 L28,25 L8,44 L18,46 Z" fill="url(#rl-wing-b)" />
      {/* tail */}
      <path d="M8,21 L2,14 L6,14 L12,21 Z" fill="#a8a8a8" />
      <path d="M8,25 L2,32 L6,32 L12,25 Z" fill="#a8a8a8" />
      {/* fuselage */}
      <ellipse cx="34" cy="23" rx="29" ry="7" fill="url(#rl-body)" />
      {/* nose cone */}
      <path
        d="M61,19.5 C66,21.5 67.5,23 67,23 C67.5,23 66,24.5 61,26.5 L58,23 Z"
        fill="#d8d8d8"
      />
      {/* cockpit */}
      <ellipse cx="57" cy="23" rx="4" ry="3" fill="#7ec8e8" opacity="0.9" />
    </svg>
  );
}

export default function RunwayLoader({
  phase,
  labels,
  onDone,
}: {
  phase: RunwayPhase;
  labels: { preparing: string; takingOff: string };
  /** Fired once the take-off animation completes (phase "done" only). */
  onDone?: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const [takeoff, setTakeoff] = useState(false);
  // Refs, not state: the rAF loop must read the latest values without
  // re-subscribing every frame, and onDone's identity may change on
  // every parent render.
  const progressRef = useRef(0);
  const onDoneRef = useRef(onDone);
  // Keep the callback fresh without touching the ref during render, and
  // without re-subscribing the rAF loop when its identity changes.
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    // "failed" freezes: no loop runs, the plane stays where it stopped.
    if (phase === "failed") return;

    let alive = true;
    let raf = 0;
    const from = progressRef.current;

    const commit = (p: number) => {
      progressRef.current = p;
      setProgress(p);
    };

    if (phase === "done") {
      // Sprint the remaining distance, then lift off and report back.
      const t0 = performance.now();
      const step = (ts: number) => {
        if (!alive) return;
        const k = Math.min((ts - t0) / SPRINT_MS, 1);
        commit(from + (100 - from) * (1 - Math.pow(1 - k, 2)));
        if (k < 1) {
          raf = requestAnimationFrame(step);
          return;
        }
        setTakeoff(true);
        window.setTimeout(() => {
          if (alive) onDoneRef.current?.();
        }, TAKEOFF_MS);
      };
      raf = requestAnimationFrame(step);
      return () => {
        alive = false;
        cancelAnimationFrame(raf);
      };
    }

    // "running": exponential ease toward the cap — never reaches it, so
    // a slow server simply means a longer roll, not a stalled UI.
    const t0 = performance.now();
    const step = (ts: number) => {
      if (!alive) return;
      const p = Math.min(
        from + (ROLL_CAP - from) * (1 - Math.exp(-(ts - t0) / ROLL_TAU)),
        ROLL_CAP,
      );
      commit(p);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [phase]);

  const planePct = Math.min(progress, 100);

  return (
    <div className="flex w-full items-center justify-center py-2" role="status" aria-live="polite">
      <div className="flex w-full max-w-[440px] flex-col items-center gap-3 px-1">
        {/* runway */}
        <div className="bg-muted relative h-11 w-full overflow-visible rounded-full shadow-inner sm:h-12">
          {/* centre dashes */}
          <div
            className="pointer-events-none absolute top-1/2 -translate-y-px"
            style={{
              left: 18,
              right: 18,
              height: 2,
              backgroundImage:
                "repeating-linear-gradient(to right, rgba(255,255,255,0.42) 0, rgba(255,255,255,0.42) 10px, transparent 10px, transparent 24px)",
            }}
          />
          {/* travelled distance — sidebar blue */}
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${progress}%`,
              background: TRACK_FILL,
              boxShadow: "inset 0 1px 3px rgba(255,255,255,0.1)",
            }}
          />
          {/* engine wash once rolling */}
          {!takeoff && progress > 30 && (
            <motion.div
              className="pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full"
              style={{
                right: `calc(${100 - planePct}% + 26px)`,
                width: Math.min(((progress - 30) / 70) * 56, 56),
                height: 22,
                background:
                  "radial-gradient(ellipse at right, rgba(255,140,20,0.3), transparent)",
                filter: "blur(8px)",
              }}
              animate={{ opacity: [0.3, 0.75, 0.2, 0.65, 0.3] }}
              transition={{ duration: 0.2, repeat: Infinity }}
            />
          )}
          {/* the plane */}
          {!takeoff && (
            <div
              className="pointer-events-none absolute top-1/2 z-20"
              style={{
                left: `${planePct}%`,
                transform: "translateX(-50%) translateY(-50%)",
              }}
            >
              <Airplane />
            </div>
          )}
          {takeoff && (
            <motion.div
              className="pointer-events-none absolute top-1/2 z-20"
              style={{
                left: `${planePct}%`,
                transform: "translateX(-50%) translateY(-50%)",
              }}
              initial={{ opacity: 1, x: 0, scale: 1 }}
              animate={{ opacity: 0, x: 120, scale: 1.8 }}
              transition={{ duration: 0.7, ease: "easeIn" }}
            >
              <Airplane />
            </motion.div>
          )}
        </div>

        {/* readout */}
        <div className="flex flex-col items-center gap-0.5">
          <div className="flex items-baseline gap-1">
            <span className="text-foreground text-2xl font-bold tabular-nums sm:text-[28px]">
              {Math.round(progress)}
            </span>
            <span className="text-muted-foreground text-sm font-semibold sm:text-base">%</span>
          </div>
          <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest sm:text-[11px]">
            {takeoff ? labels.takingOff : labels.preparing}
          </span>
        </div>
      </div>
    </div>
  );
}
