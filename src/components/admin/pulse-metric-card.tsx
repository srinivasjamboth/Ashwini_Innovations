"use client";

import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { SkeletonCard } from "@/components/dashboard/skeleton";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Pulse metric cards — the clean KPI tile (tinted icon chip, label with
 * its definition tooltip, big number, accent hairline) mounted back onto
 * the "floating card gallery" motion kit: mouse-driven 3D perspective
 * tilt on the grid, spring-staggered entrance, hover lift, an accent
 * glow, a per-card floating orb, ambient drifting particles behind the
 * grid, and a click-to-expand overlay.
 *
 * Admin (Pulse) only — nothing outside /ashwini-control imports this.
 * Motion uses a deterministic hash (not Math.random()) so server and
 * client render identical markup; the glow/orb colours follow each
 * card's accent rather than a single fixed hue.
 */

/** Per-metric accent — the admin palette is sea-blue ONLY (spec Part 2:
 *  "no green, purple, or red … chart colors"), so the six cards differ
 *  by SHADE of sea plus one neutral slate, not by hue. Static class
 *  strings so Tailwind can see them. */
export type PulseAccent = "sea" | "deep" | "mid" | "foam" | "steel" | "slate";

const ACCENT_STYLES: Record<
  PulseAccent,
  { chip: string; hover: string; bar: string; glow: string; orb: string }
> = {
  sea: {
    chip: "bg-[var(--sea-600)]/10 text-[var(--sea-600)]",
    hover: "hover:border-[var(--sea-600)]/40",
    bar: "from-[var(--sea-600)]/60",
    glow: "rgba(27, 106, 143, 0.5)",
    orb: "from-[var(--sea-600)] to-[var(--sea-800)]",
  },
  deep: {
    chip: "bg-[var(--sea-800)]/10 text-[var(--sea-800)]",
    hover: "hover:border-[var(--sea-800)]/40",
    bar: "from-[var(--sea-800)]/60",
    glow: "rgba(13, 59, 84, 0.5)",
    orb: "from-[var(--sea-800)] to-[var(--sea-950)]",
  },
  mid: {
    chip: "bg-[var(--sea-700)]/10 text-[var(--sea-700)]",
    hover: "hover:border-[var(--sea-700)]/40",
    bar: "from-[var(--sea-700)]/60",
    glow: "rgba(19, 80, 112, 0.5)",
    orb: "from-[var(--sea-700)] to-[var(--sea-900)]",
  },
  foam: {
    chip: "bg-[var(--sea-100)] text-[var(--sea-800)]",
    hover: "hover:border-[var(--sea-200)]",
    bar: "from-[var(--sea-200)]",
    glow: "rgba(191, 214, 227, 0.5)",
    orb: "from-[var(--sea-200)] to-[var(--sea-600)]",
  },
  steel: {
    chip: "bg-[var(--sea-muted)]/10 text-[var(--sea-muted)]",
    hover: "hover:border-[var(--sea-muted)]/40",
    bar: "from-[var(--sea-muted)]/60",
    glow: "rgba(91, 115, 132, 0.45)",
    orb: "from-[var(--sea-muted)] to-[var(--sea-700)]",
  },
  slate: {
    chip: "bg-slate-500/10 text-slate-600",
    hover: "hover:border-slate-500/40",
    bar: "from-slate-500/60",
    glow: "rgba(100, 116, 139, 0.45)",
    orb: "from-slate-500 to-[var(--sea-700)]",
  },
};

/** Deterministic stand-in for Math.random() — stable across SSR and
 *  hydration while still looking scattered. */
function hashRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Perspective host for the card grid: tilts toward the cursor
 * (rotateX/rotateY, /25 divisor, 1500px perspective) and floats 20
 * ambient particles behind it. Also the responsive layout: 3×2 desktop /
 * 2×3 tablet / 1 column mobile.
 */
export function FloatingCardGrid({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // Subtle divisor (/80) keeps the perspective tilt minimal — a hint
      // of depth that follows the cursor without the strong gallery lean.
      setMousePosition({
        x: (e.clientX - rect.left - rect.width / 2) / 80,
        y: (e.clientY - rect.top - rect.height / 2) / 80,
      });
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden py-2"
      style={{ perspective: "1500px" }}
    >
      {/* Ambient background particles */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden={true}>
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-[var(--sea-800)] opacity-10"
            style={{
              width: `${hashRandom(i) * 6 + 1}px`,
              height: `${hashRandom(i + 51) * 6 + 1}px`,
              top: `${hashRandom(i + 102) * 100}%`,
              left: `${hashRandom(i + 153) * 100}%`,
              animation: `ashwini-admin-float ${hashRandom(i + 204) * 10 + 20}s linear infinite`,
              animationDelay: `${hashRandom(i + 255) * 20}s`,
            }}
          />
        ))}
      </div>

      <motion.div
        className={cn(
          "relative z-10 grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
          className,
        )}
        style={{
          transform: `rotateX(${-mousePosition.y}deg) rotateY(${mousePosition.x}deg)`,
          transformStyle: "preserve-3d",
        }}
      >
        {children}
      </motion.div>
    </div>
  );
}

/** Shared spring-entrance used by every grid slot (cards + placeholders). */
const entrance = (index: number) => ({
  initial: { opacity: 0, y: 50 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, delay: index * 0.1, type: "spring" as const, stiffness: 100 },
});

/**
 * One Pulse metric card: the clean accent tile wrapped in the gallery's
 * floating motion — spring stagger entrance, hover lift, accent glow and
 * a click-to-expand overlay.
 */
export function PulseMetricCard({
  label,
  value,
  icon: Icon,
  definition,
  accent = "sea",
  className,
  index = 0,
}: {
  label: string;
  value: number;
  icon: ComponentType<{ className?: string }>;
  definition: string;
  accent?: PulseAccent;
  className?: string;
  index?: number;
}) {
  const [active, setActive] = useState(false);
  const styles = ACCENT_STYLES[accent];

  // For accessibility and mobile (gallery's Enter/Space toggle)
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActive((prev) => (prev ? false : true));
    }
  };

  return (
    <motion.div
      className="group relative cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => setActive((prev) => (prev ? false : true))}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      aria-expanded={active}
      initial={{ opacity: 0, y: 50 }}
      animate={{ opacity: 1, y: 0, z: active ? 100 : 0, scale: active ? 1.05 : 1 }}
      transition={{ duration: 0.6, delay: index * 0.1, type: "spring", stiffness: 100 }}
      whileHover={{ z: 30, scale: 1.03, transition: { duration: 0.2 } }}
      style={{ transformStyle: "preserve-3d" }}
    >
      {/* Accent glow */}
      <motion.div
        className="absolute -inset-0.5 rounded-xl opacity-0 group-hover:opacity-100"
        animate={{ opacity: active ? 0.6 : 0, boxShadow: `0 0 40px 2px ${styles.glow}` }}
        transition={{ duration: 0.4 }}
        style={{ background: `linear-gradient(135deg, ${styles.glow}, transparent 80%)` }}
        aria-hidden={true}
      />

      {/* Card body — clean accent tile */}
      <div
        className={cn(
          "relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card/80 p-5 backdrop-blur-sm",
          styles.hover,
          className,
        )}
        style={{
          transformStyle: "preserve-3d",
          boxShadow: "0 25px 50px -12px rgba(13, 59, 84, 0.15)",
        }}
      >
        {/* Floating orb */}
        <div
          className={cn(
            "absolute -right-4 -top-4 size-24 rounded-full bg-gradient-to-r opacity-30 blur-xl",
            styles.orb,
          )}
          style={{ transform: `translateZ(${hashRandom(index + 7) * 10 + 10}px)` }}
          aria-hidden={true}
        />

        {/* Accent hairline along the top edge */}
        <span
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r to-transparent",
            styles.bar,
          )}
          aria-hidden={true}
        />

        <div
          className="flex items-start justify-between gap-3"
          style={{ transform: "translateZ(30px)" }}
        >
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-lg",
              styles.chip,
            )}
          >
            <Icon className="size-5" aria-hidden={true} />
          </div>

          <TooltipProvider delay={200}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Definition of ${label}`}
                    className="shrink-0 rounded-sm text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <Info className="size-4" aria-hidden={true} />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-60 whitespace-normal text-left">
                {definition}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        <p
          className="mt-4 text-3xl font-bold tabular-nums text-foreground"
          style={{ transform: "translateZ(40px)" }}
        >
          {value.toLocaleString()}
        </p>
        <p className="mt-1 text-sm font-medium text-muted-foreground">{label}</p>
      </div>

      {/* Expanded overlay — click-to-expand panel with this card's
          value/label/definition */}
      <AnimatePresence>
        {active && (
          <motion.div
            className="absolute inset-0 z-50 flex flex-col rounded-xl bg-card/95 p-5 backdrop-blur-md"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.3 }}
            style={{ transform: "translateZ(60px)" }}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setActive(false);
              }}
              aria-label="Close"
              className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden={true}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <p className="text-3xl font-bold tabular-nums text-foreground">{value.toLocaleString()}</p>
            <h3 className="mt-2 text-lg font-bold text-foreground">{label}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{definition}</p>

            <span className="mt-auto inline-block w-fit rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
              Pulse metric
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** Loading placeholder — same silhouette, rides the same stagger. */
export function PulseMetricSkeleton({ index = 0 }: { index?: number }) {
  return (
    <motion.div className="relative" {...entrance(index)}>
      <SkeletonCard />
    </motion.div>
  );
}

/** Error placeholder with the retry affordance (spec §4.1). */
export function PulseMetricError({
  onRetry,
  index = 0,
}: {
  onRetry: () => void;
  index?: number;
}) {
  return (
    <motion.div
      className="relative flex min-h-32 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-destructive/40 bg-card/40 p-5 text-center"
      {...entrance(index)}
    >
      <p className="text-sm font-medium text-muted-foreground">
        Couldn’t load this number
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </motion.div>
  );
}
