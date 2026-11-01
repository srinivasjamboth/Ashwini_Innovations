"use client";

// ============================================================
// useCheckout — the shared controller behind every Subscribe /
// Upgrade / Switch / Renew button (spec PART 4).
//
// It wraps `runCheckout` (the one orchestration in lib/plans/checkout-client)
// and turns its phases into button state ("creating" → spinner, "confirming"
// → "Confirming your payment..."), then refreshes the plan snapshot on
// success so the expired banner and disabled buttons lift with no reload.
//
// Surfaces keep their OWN look; they just read `busy` / `phaseLabel` /
// `outcome` from here. That is what lets the landing page, the upgrade modal
// and the billing tab share one flow without duplicating logic.
// ============================================================

import { useCallback, useRef, useState } from "react";

import {
  runCheckout,
  type CheckoutOutcome,
  type CheckoutPhase,
} from "@/lib/plans/checkout-client";
import { usePlan } from "@/hooks/use-plan";

export interface UseCheckout {
  /** True while an order is being created or a payment is being confirmed —
   *  bind to `disabled` so a second click cannot stack orders (spec PART 4). */
  busy: boolean;
  /** Current phase, for precise button copy. */
  phase: CheckoutPhase;
  /** The last terminal outcome, for a success/failure message. */
  outcome: CheckoutOutcome | null;
  /** Start (or retry — the same open order is reused) checkout for a plan. */
  startCheckout: (planKey: string, cycle: "monthly" | "yearly") => Promise<CheckoutOutcome>;
  reset: () => void;
}

export function useCheckout(): UseCheckout {
  const { refresh } = usePlan();
  const [phase, setPhase] = useState<CheckoutPhase>("idle");
  const [outcome, setOutcome] = useState<CheckoutOutcome | null>(null);
  // Guards against two overlapping runs (double click racing a slow open).
  const runningRef = useRef(false);

  const startCheckout = useCallback(
    async (planKey: string, cycle: "monthly" | "yearly"): Promise<CheckoutOutcome> => {
      if (runningRef.current) {
        // Already mid-flow; report the in-flight state rather than stacking.
        return outcome ?? { status: "error", code: "in_progress", message: "A payment is already in progress." };
      }
      runningRef.current = true;
      setOutcome(null);
      let result: CheckoutOutcome;
      try {
        result = await runCheckout(planKey, cycle, setPhase);
      } finally {
        runningRef.current = false;
        setPhase("idle");
      }
      setOutcome(result);
      // A confirmed activation lifts the plan UI immediately (no reload).
      if (result.status === "success") void refresh();
      return result;
    },
    [outcome, refresh],
  );

  const reset = useCallback(() => {
    setOutcome(null);
    setPhase("idle");
  }, []);

  return {
    busy: phase !== "idle",
    phase,
    outcome,
    startCheckout,
    reset,
  };
}
