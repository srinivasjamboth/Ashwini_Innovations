"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Minus } from "lucide-react";
import { ADMIN_ROOT } from "@/lib/admin/constants";
import { UNLIMITED } from "@/lib/plans/config";
import type { VaultDetailDto, VaultHistoryRow, VaultPlanOption } from "@/lib/admin/vault";
import { Button } from "@/components/ui/button";
import {
  PaymentStateLine,
  VaultStatusBadge,
  expiryHint,
  formatDay,
  formatInr,
  formatRegistered,
} from "./admin-format";
import { SubscriptionUpdatePanel } from "./subscription-update-panel";

/**
 * Subscription detail — /ashwini-control/plan-vault/[subscriptionId]
 * (spec Part 5). Deep-linkable server-rendered page; everything here
 * comes from real tables: the subscription row, plan_limits /
 * plan_features via the SAME entitlements engine enforcement uses,
 * the customer's profile, and subscription_history (049).
 */

const HISTORY_PAGE_SIZE = 10;

/* UI labels only — the values themselves are never hard-coded. */
const FEATURE_LABELS: Record<string, string> = {
  contacts: "Contacts",
  bulk_messages: "Bulk messages",
  templates: "Templates",
  quick_replies: "Quick replies",
  automation_flows: "Automation flows",
  whatsapp_forms: "WhatsApp forms",
  fields_tags: "Fields & tags",
  broadcast_scheduler: "Broadcast scheduler",
  ai_agent: "AI agent",
};

const SOURCE_LABELS: Record<string, string> = {
  trial: "Trial",
  customer_payment: "Customer payment",
  renewal: "Renewal",
  cancellation: "Cancellation",
  expiry: "Expiry",
  admin_update: "Admin update",
  system: "System",
  backfill: "Backfilled",
};

const STORED_STATUS_LABELS: Record<string, string> = {
  trialing: "Trial",
  active: "Active",
  expired: "Expired",
  canceled: "Cancelled",
  past_due: "Past due",
};

function featureLabel(key: string): string {
  return FEATURE_LABELS[key] ?? key.replace(/_/g, " ");
}

// The window a limit is measured over, in plain words. `yearly` is a
// stored period (migration 052), not a derived one — a yearly plan shows
// the yearly row it actually enforces, so this only phrases it.
function periodWord(period: string): string {
  if (period === "monthly") return "per month";
  if (period === "yearly") return "per year";
  return "total";
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-2 last:border-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm text-foreground">{children}</dd>
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <h3 className="border-b border-[var(--sea-200)] px-5 py-3 text-sm font-semibold text-[var(--sea-800)]">
        {title}
      </h3>
      <div className="px-5 py-3">{children}</div>
    </section>
  );
}

export function SubscriptionDetail({
  detail,
  plans,
  fromMemberLedger = false,
}: {
  detail: VaultDetailDto;
  plans: VaultPlanOption[];
  /** Deep-linked from the Member Ledger (spec Part 3) — the back link
   *  then returns there instead of Plan Vault. Same page, no duplicate. */
  fromMemberLedger?: boolean;
}) {
  const router = useRouter();
  const [panelOpen, setPanelOpen] = useState(false);
  const [histPage, setHistPage] = useState(1);
  const sub = detail.subscription;
  const { history } = detail;

  const histPageCount = Math.max(1, Math.ceil(history.rows.length / HISTORY_PAGE_SIZE));
  const safeHistPage = Math.min(histPage, histPageCount);
  const histRows = history.rows.slice(
    (safeHistPage - 1) * HISTORY_PAGE_SIZE,
    safeHistPage * HISTORY_PAGE_SIZE,
  );

  return (
    <div className="space-y-4">
      {/* Header: back link + the same Update panel the list opens */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href={fromMemberLedger ? `${ADMIN_ROOT}/member-ledger` : `${ADMIN_ROOT}/plan-vault`}
            className="inline-flex items-center gap-1.5 text-sm text-[var(--sea-600)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden={true} />
            {fromMemberLedger ? "Member Ledger" : "Plan Vault"}
          </Link>
          <h2 className="mt-1 text-2xl font-bold text-[var(--sea-800)]">
            {sub.planName} subscription
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {sub.customer.name} · {sub.customer.email}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setPanelOpen(true)}
          className="bg-[var(--sea-800)] text-white hover:bg-[var(--sea-700)]"
        >
          Update subscription
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 1. Subscription plan information */}
        <SectionCard title="Subscription">
          <dl>
            <InfoRow label="Plan">{sub.planName}</InfoRow>
            <InfoRow label="Billing cycle">{sub.billingCycle === "yearly" ? "Yearly" : "Monthly"}</InfoRow>
            <InfoRow label="Plan price">
              {(detail.plan.prices[sub.billingCycle === "yearly" ? "yearly" : "monthly"] ?? null) === null
                ? "—"
                : formatInr(detail.plan.prices[sub.billingCycle === "yearly" ? "yearly" : "monthly"] as number)}
            </InfoRow>
            <InfoRow label="Status">
              <span className="inline-flex items-center gap-2">
                <VaultStatusBadge status={sub.status} />
                <PaymentStateLine state={sub.paymentState} />
              </span>
            </InfoRow>
            <InfoRow label="Subscribed on">{formatDay(sub.subscribedOn)}</InfoRow>
            <InfoRow label="Current period start">{formatDay(sub.periodStart)}</InfoRow>
            <InfoRow label="Expires on">
              {formatDay(sub.expiresOn)}{" "}
              <span className="text-xs text-muted-foreground">({expiryHint(sub.expiresOn)})</span>
            </InfoRow>
            {sub.trialEnd && <InfoRow label="Trial end">{formatDay(sub.trialEnd)}</InfoRow>}
            {sub.cancelledOn && <InfoRow label="Cancelled on">{formatDay(sub.cancelledOn)}</InfoRow>}
            <InfoRow label="Amount charged">
              <span className="tabular-nums">{formatInr(sub.amount)}</span>
            </InfoRow>
            {sub.gatewaySubscriptionId && (
              <InfoRow label="Gateway reference">
                <span className="font-mono text-xs">
                  {sub.gateway ?? "gateway"} · {sub.gatewaySubscriptionId}
                </span>
              </InfoRow>
            )}
          </dl>
        </SectionCard>

        {/* 2. Customer basic information */}
        <SectionCard title="Customer">
          <dl>
            <InfoRow label="Name">{detail.customer.name}</InfoRow>
            <InfoRow label="Email">{detail.customer.email}</InfoRow>
            <InfoRow label="Phone">{detail.customer.phone ?? "—"}</InfoRow>
            <InfoRow label="Account">{detail.customer.accountName ?? "—"}</InfoRow>
            <InfoRow label="Registered on">
              {detail.customer.registeredAt ? formatRegistered(detail.customer.registeredAt) : "—"}
            </InfoRow>
            <InfoRow label="Last active">
              {detail.customer.lastActiveAt ? formatRegistered(detail.customer.lastActiveAt) : "—"}
            </InfoRow>
          </dl>
        </SectionCard>
      </div>

      {/* Plan limits + features — straight from plan_limits /
          plan_features with live usage from the enforcement engine. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Plan limits (usage vs limit)">
          {detail.plan.limits.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No limits defined for this plan.</p>
          ) : (
            <dl>
              {detail.plan.limits.map((l) => {
                const used = detail.usage[l.feature];
                return (
                  <InfoRow key={l.feature} label={featureLabel(l.feature)}>
                    <span className="tabular-nums">
                      {used != null && <span className="text-muted-foreground">{used.toLocaleString("en-IN")} / </span>}
                      {l.value === UNLIMITED ? "Unlimited" : l.value.toLocaleString("en-IN")}
                    </span>
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {periodWord(l.period)}
                    </span>
                  </InfoRow>
                );
              })}
            </dl>
          )}
        </SectionCard>
        <SectionCard title="Plan features">
          {detail.plan.features.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No feature flags defined for this plan.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {detail.plan.features.map((f) => (
                <li key={f.feature} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-foreground">{featureLabel(f.feature)}</span>
                  <span
                    className={
                      "inline-flex size-6 items-center justify-center rounded-full " +
                      (f.enabled
                        ? "bg-[var(--sea-800)] text-white"
                        : "bg-muted text-muted-foreground")
                    }
                    title={f.enabled ? "Included" : "Not included"}
                  >
                    {f.enabled ? (
                      <Check className="h-3.5 w-3.5" aria-hidden={true} />
                    ) : (
                      <Minus className="h-3.5 w-3.5" aria-hidden={true} />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* 3. Subscription history */}
      <section className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--sea-200)] px-5 py-3">
          <h3 className="text-sm font-semibold text-[var(--sea-800)]">Subscription history</h3>
          <p className="text-xs text-muted-foreground">
            {history.total.toLocaleString("en-IN")} subscription record
            {history.total === 1 ? "" : "s"} ({history.paid.toLocaleString("en-IN")} paid,{" "}
            {history.trialOrOther.toLocaleString("en-IN")} trial or other)
          </p>
        </div>
        {history.rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No history rows yet — they are written by the 049 trigger and backfill. If the
            migration hasn&apos;t been applied, this list is legitimately empty.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Subscription history, newest first — {history.total} records
                </caption>
                <thead>
                  <tr className="border-b border-[var(--sea-200)] text-left text-xs font-medium text-muted-foreground">
                    <th scope="col" className="px-4 py-2">#</th>
                    <th scope="col" className="px-4 py-2">Plan</th>
                    <th scope="col" className="px-4 py-2">Billing</th>
                    <th scope="col" className="px-4 py-2">Started</th>
                    <th scope="col" className="px-4 py-2">Ends</th>
                    <th scope="col" className="px-4 py-2">Amount</th>
                    <th scope="col" className="px-4 py-2">Status</th>
                    <th scope="col" className="px-4 py-2">Source</th>
                    <th scope="col" className="px-4 py-2">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {histRows.map((h, i) => (
                    <HistoryRow
                      key={h.id}
                      row={h}
                      index={(safeHistPage - 1) * HISTORY_PAGE_SIZE + i}
                      total={history.total}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {history.rows.length > HISTORY_PAGE_SIZE && (
              <div className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3 text-sm text-muted-foreground">
                <p>
                  Showing {((safeHistPage - 1) * HISTORY_PAGE_SIZE + 1).toLocaleString("en-IN")} to{" "}
                  {Math.min(safeHistPage * HISTORY_PAGE_SIZE, history.total).toLocaleString("en-IN")} of{" "}
                  {history.total.toLocaleString("en-IN")}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={safeHistPage <= 1}
                    onClick={() => setHistPage(safeHistPage - 1)}
                    aria-label="Previous page"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden={true} />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={safeHistPage >= histPageCount}
                    onClick={() => setHistPage(safeHistPage + 1)}
                    aria-label="Next page"
                  >
                    <ArrowLeft className="h-4 w-4 rotate-180" aria-hidden={true} />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* Same update panel as the list (spec Part 5) — after a save,
          router.refresh() re-runs the server loader for this page. */}
      <SubscriptionUpdatePanel
        subscription={panelOpen ? sub : null}
        plans={plans}
        onClose={() => setPanelOpen(false)}
        onUpdated={() => router.refresh()}
      />
    </div>
  );
}

/** One history row; "#" counts down from the total so the oldest
 *  record is #1 regardless of pagination. */
function HistoryRow({ row, index, total }: { row: VaultHistoryRow; index: number; total: number }) {
  return (
    <tr
      className={
        "border-b border-border/60 last:border-0 transition-colors hover:bg-[var(--sea-100)]/50 " +
        (row.isCurrent ? "bg-[var(--sea-50)]" : "")
      }
    >
      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{total - index}</td>
      <td className="px-4 py-2.5">
        <span className="font-medium text-foreground">{row.planName ?? "—"}</span>
        {row.isCurrent && (
          <span className="ml-2 rounded-full bg-[var(--sea-800)] px-2 py-0.5 text-[11px] font-medium text-white">
            Current
          </span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {row.billingCycle === "yearly" ? "Yearly" : row.billingCycle === "monthly" ? "Monthly" : "—"}
      </td>
      <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{formatDay(row.started)}</td>
      <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{formatDay(row.ends)}</td>
      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-foreground">
        {row.amount == null ? "—" : formatInr(row.amount)}
      </td>
      <td className="px-4 py-2.5 text-muted-foreground">
        {row.status ? (STORED_STATUS_LABELS[row.status] ?? row.status) : "—"}
      </td>
      <td className="px-4 py-2.5 text-muted-foreground">{SOURCE_LABELS[row.source] ?? row.source}</td>
      <td className="max-w-24 truncate px-4 py-2.5 font-mono text-xs text-muted-foreground" title={row.reference ?? undefined}>
        {row.reference ? row.reference.slice(0, 8) : "—"}
      </td>
    </tr>
  );
}
