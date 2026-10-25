"use client";

import { Badge } from "@/components/ui/badge";
import { ADMIN_TIMEZONE } from "@/lib/admin/constants";
import { cn } from "@/lib/utils";
import type { VaultStatus } from "@/lib/admin/vault";

/** "24 Oct 2026, 4:32 PM" — cut in the admin timezone (Asia/Kolkata)
 *  everywhere, matching the chart's month buckets. */
export function formatRegistered(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: ADMIN_TIMEZONE,
  }).format(d);
}

/** Plain date ("24 Oct 2026") in the admin timezone — the Vault's
 *  Subscribed/Expires columns show the day, not the minute. */
export function formatDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: ADMIN_TIMEZONE,
  }).format(d);
}

/** Whole days from "today" (admin tz) to an ISO instant, tz-day
 *  boundaries like the server's date filters use. */
function dayNumberInTz(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ADMIN_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant); // "YYYY-MM-DD"
  const [y, m, d] = parts.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Relative expiry hint under the Expires-on date: "in 12 days",
 *  "today", "expired 3 days ago". Day-granular in the admin tz. */
export function expiryHint(expiresIso: string | null): string {
  if (!expiresIso) return "—";
  const d = new Date(expiresIso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = dayNumberInTz(d) - dayNumberInTz(new Date());
  if (days === 0) return "today";
  if (days === 1) return "in 1 day";
  if (days === -1) return "expired 1 day ago";
  if (days > 1) return `in ${days.toLocaleString()} days`;
  return `expired ${Math.abs(days).toLocaleString()} days ago`;
}

/** Relative-ish "Last login" text from an ISO timestamp. */
export function formatLastLogin(iso: string | null): string {
  if (!iso) return "First admin session";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMin = Math.round((Date.now() - d.getTime()) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffMin < 60 * 24) return `${Math.round(diffMin / 60)} h ago`;
  return formatRegistered(iso);
}

/**
 * Indian-format money. The billing schema stores RUPEES in
 * NUMERIC(12,2) (048's plan_prices / payment_transactions) — never
 * paise — so the value is formatted as-is with en-IN grouping;
 * raw stored values never reach the screen.
 */
export function formatInr(rupees: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

/**
 * Subscription type badge — sea family only (admin palette, spec
 * Part 2): Free = neutral outline, Monthly = sea tint, Yearly = sea
 * solid-tint. Content surfaces stay light; no green/violet/red.
 */
export function SubscriptionBadge({
  type,
  className,
}: {
  type: "Free" | "Monthly" | "Yearly";
  className?: string;
}) {
  return (
    <Badge
      variant={type === "Free" ? "outline" : "secondary"}
      className={cn(
        type === "Monthly" && "bg-[var(--sea-100)] text-[var(--sea-700)]",
        type === "Yearly" && "bg-[var(--sea-600)]/15 text-[var(--sea-800)]",
        className,
      )}
    >
      {type}
    </Badge>
  );
}

/**
 * Effective-status badge — ONE shared vocabulary across the Vault,
 * the detail page and anywhere else a subscription status renders.
 * Nearly monochrome per spec: Active = solid sea-800, Trial = sea-100
 * on sea-800 text, Expired/Cancelled = neutral grey, Past due = the
 * single allowed warm exception (it needs the owner's attention).
 */
const VAULT_STATUS_STYLES: Record<VaultStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-[var(--sea-800)] text-white border-transparent" },
  trial: { label: "Trial", className: "bg-[var(--sea-100)] text-[var(--sea-800)] border-transparent" },
  past_due: { label: "Past due", className: "bg-amber-100 text-amber-800 border-transparent" },
  cancelled: { label: "Cancelled", className: "bg-muted text-muted-foreground" },
  expired: { label: "Expired", className: "bg-muted text-muted-foreground" },
};

export function VaultStatusBadge({ status, className }: { status: VaultStatus; className?: string }) {
  const s = VAULT_STATUS_STYLES[status];
  return <Badge className={cn(s.className, className)}>{s.label}</Badge>;
}

/** Secondary line under the status badge — the latest payment state
 *  from payment_transactions. Failed is RED TEXT ONLY (no red chip),
 *  the spec's other permitted exception. */
export function PaymentStateLine({
  state,
}: {
  state: "paid" | "created" | "failed" | "refunded" | null;
}) {
  if (!state) return null;
  const label =
    state === "paid" ? "Paid" : state === "created" ? "Initiated" : state === "failed" ? "Payment failed" : "Refunded";
  return (
    <span
      className={cn(
        "text-[11px]",
        state === "failed" ? "font-medium text-red-600" : "text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

/** Deterministic initials avatar (customers may have no avatar). */
export function InitialsAvatar({ name, className }: { name: string; className?: string }) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";
  return (
    <span
      aria-hidden={true}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--sea-100)] text-xs font-semibold text-[var(--sea-800)]",
        className,
      )}
    >
      {initials}
    </span>
  );
}
