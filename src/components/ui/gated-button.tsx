"use client";

// ============================================================
// GatedButton — Button + role-gated "Read-only" tooltip helper.
//
// The wider problem this solves:
//
//   A bare `<Button disabled title="Read-only — ...">` doesn't
//   render a tooltip in Safari or older Firefox because those
//   browsers don't fire mouse events on disabled form controls.
//   Title attributes only render when the element receives a
//   mouseover. The 9-PR multi-user series relied on this pattern
//   for every "read-only for viewer" CTA across the app, which
//   meant viewers on those browsers saw a silently-disabled
//   button with no explanation.
//
//   Wrapping the disabled button in a `<span title=...>` makes
//   the tooltip target a non-disabled ancestor that does receive
//   mouseover, so the tooltip renders everywhere. The span also
//   serves as a single mounting point for `aria-label` /
//   `aria-disabled` if a screen reader needs richer signalling
//   later.
//
// The minor problem it also solves:
//
//   Five list pages had near-identical
//   `READ_ONLY_TITLE = "Read-only — your role can't ..."`
//   constants. GatedButton takes a single `gateReason` prop
//   and centralises the tooltip wording (with per-action
//   defaults).
//
// Plan gating (spec PART 3/5) — additive & opt-in:
//
//   Pass `planFeature` (a counted limit) or `planFlag` (a feature
//   flag) and the button ALSO disables when the account is at that
//   limit or lacks that feature, swaps the tooltip to an "upgrade"
//   message, and opens the shared upgrade modal on click instead of
//   doing nothing. Usages that pass neither prop are byte-for-byte
//   the old role-gated component — so nothing that exists today
//   changes behaviour. The backend 403 stays the source of truth;
//   this is the client pre-check + affordance.
//
// Use it like:
//
//   <GatedButton
//     canAct={canCreate}
//     gateReason="create broadcasts"
//     planFeature="bulk_messages"
//     onClick={() => router.push("/broadcasts/new")}
//   >
//     <Plus className="h-4 w-4" /> New Broadcast
//   </GatedButton>
//
// `canAct` defaults to true so unrelated usages still work.
// When `canAct` is false, the button is `disabled` and the
// wrapping span gets a `title` of `"Read-only — your role
// can't ${gateReason}"`.
// ============================================================

import type { ComponentProps, ReactNode } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePlan } from "@/hooks/use-plan";
import type { FeatureFlag, LimitFeature } from "@/lib/plans/config";

interface GatedButtonProps extends Omit<ComponentProps<typeof Button>, "title"> {
  /** False → button is disabled and the wrapper span shows the
   *  "Read-only" tooltip. Defaults to `true` so a `<GatedButton>`
   *  without the prop is just a Button. */
  canAct?: boolean;
  /** Verb phrase that completes the sentence
   *  `"Read-only — your role can't <gateReason>"`. Provided
   *  per-call so each CTA can name what it does ("create flows",
   *  "send messages", "add contacts"). */
  gateReason?: string;
  /** Optional fallback title for the non-gated case. */
  title?: string;
  /** Opt-in plan gate: a counted limit (e.g. "contacts"). When the
   *  account is at/over this cap, the button disables and clicking it
   *  opens the upgrade modal. Ignored while the plan snapshot loads
   *  (fails open so nav doesn't flicker). */
  planFeature?: LimitFeature;
  /** Opt-in plan gate: a feature flag (e.g. "broadcast_scheduler").
   *  When the plan doesn't include it (or the subscription expired),
   *  the button disables and clicking it opens the upgrade modal. */
  planFlag?: FeatureFlag;
  children?: ReactNode;
}

export function GatedButton({
  canAct = true,
  gateReason,
  title,
  planFeature,
  planFlag,
  disabled,
  className,
  children,
  onClick,
  ...rest
}: GatedButtonProps) {
  const t = useTranslations("Plans");
  const { isLimitReached, isFeatureAllowed, isExpired, openUpgrade } = usePlan();

  // Resolve the two independent gates. Role gate is caller-provided;
  // the plan gate is derived and only consulted when a prop is set.
  let planBlock: "limit" | "feature" | null = null;
  if (planFlag && !isFeatureAllowed(planFlag)) planBlock = "feature";
  else if (planFeature && isLimitReached(planFeature)) planBlock = "limit";
  const planGated = planBlock !== null;

  // ROLE / explicit disable → the button is truly `disabled` (the
  // original, unchanged behaviour: a viewer can't act at all).
  const hardDisabled = disabled || !canAct;
  // PLAN gate → the button stays clickable (so the click can open the
  // upgrade modal) but reads as gated via aria-disabled + muted styling.
  // A `disabled` button can't fire onClick, which is why the plan gate
  // is NOT modelled with the `disabled` attribute.
  const effectivelyDisabled = hardDisabled;
  const tooltip = !canAct && gateReason
    ? `Read-only — your role can't ${gateReason}`
    : planBlock === "limit"
      ? `${t("limitTitle")} — ${t("upgrade")}`
      : planBlock === "feature"
        ? `${t("featureTitle")} — ${t("upgrade")}`
        : title;

  return (
    <span
      // `inline-flex` so the span sizes to the button and doesn't
      // collapse to zero width / break inline layouts. `title`
      // here (not on the button) is what makes the tooltip work
      // in Safari / older Firefox — those browsers don't fire
      // mouseover on disabled buttons.
      className={cn(
        "inline-flex",
        (hardDisabled || planGated) && "cursor-not-allowed"
      )}
      title={tooltip}
    >
      <Button
        disabled={effectivelyDisabled}
        aria-disabled={(hardDisabled || planGated) || undefined}
        className={cn(className, planGated && !hardDisabled && "opacity-60")}
        {...rest}
        onClick={(e) => {
          // A plan-gated CTA redirects to the shared upgrade modal rather
          // than performing a send/create the backend will 403 anyway —
          // but only when the role allows the action (a hard-disabled
          // button never reaches here).
          if (planGated && !hardDisabled) {
            e.preventDefault();
            openUpgrade({ intent: isExpired ? "renew" : "upgrade", feature: planFeature, flag: planFlag });
            return;
          }
          onClick?.(e);
        }}
      >
        {children}
      </Button>
    </span>
  );
}
