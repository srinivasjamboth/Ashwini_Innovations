"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Search,
  X,
} from "lucide-react";
import { ADMIN_ROOT, VAULT_SCAN_CAP } from "@/lib/admin/constants";
import type { VaultListDto, VaultPlanOption, VaultRowDto, VaultStatus } from "@/lib/admin/vault";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  InitialsAvatar,
  PaymentStateLine,
  VaultStatusBadge,
  expiryHint,
  formatDay,
  formatInr,
} from "./admin-format";
import { SubscriptionUpdatePanel } from "./subscription-update-panel";

/**
 * Plan Vault — one row per SUBSCRIPTION record (plan history), the
 * owner's working view of who bought what and when it lapses.
 *
 * All view state (search / page / pageSize / sort / filters) lives in
 * the URL query string, so every view is shareable and survives a
 * refresh; the server (lib/admin/vault via /api/ashwini-control/vault)
 * does the searching, filtering, paging and range summary. There is
 * deliberately NO delete action — history is the point of the page;
 * cancelling or expiring happens through the Update panel.
 */

const VAULT_PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

const STATUS_OPTIONS: { value: VaultStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "trial", label: "Trial" },
  { value: "past_due", label: "Past due" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

const DATE_FIELD_OPTIONS = [
  { value: "subscribed", label: "Subscribed on" },
  { value: "expires", label: "Expires on" },
  { value: "registered", label: "Customer registered" },
] as const;

type SortField = "created" | "expires" | "amount" | "plan";

/* IST-today helpers for the range presets — day names computed in the
 * admin timezone so "This month" means the owner's month, not UTC's. */
function tzTodayParts(): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = parts.split("-").map(Number);
  return { y, m, d };
}
function isoDate(y: number, m: number, d: number): string {
  // Clamp the day (month lengths) via UTC arithmetic — Feb 31 → Mar 2.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
function lastDateOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Presets per spec 3.6 — inclusive whole days in Asia/Kolkata. */
function presetRange(preset: string): { from: string; to: string } | null {
  const { y, m, d } = tzTodayParts();
  const today = isoDate(y, m, d);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "7d": {
      const t = new Date(`${today}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() - 6);
      return { from: isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()), to: today };
    }
    case "30d": {
      const t = new Date(`${today}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() - 29);
      return { from: isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()), to: today };
    }
    case "this-month":
      return { from: isoDate(y, m, 1), to: today };
    case "last-month": {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return { from: isoDate(ly, lm, 1), to: isoDate(ly, lm, lastDateOfMonth(ly, lm)) };
    }
    default:
      return null;
  }
}

function VaultInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL is the single source of truth for the view.
  const q = searchParams.get("q") ?? "";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const pageSize = VAULT_PAGE_SIZES.includes(Number(searchParams.get("pageSize")))
    ? Number(searchParams.get("pageSize"))
    : DEFAULT_PAGE_SIZE;
  const sort = (searchParams.get("sort") ?? "created") as SortField;
  const dir = searchParams.get("dir") === "asc" ? "asc" : "desc";
  const planCsv = searchParams.get("plan") ?? "";
  const plans = planCsv ? planCsv.split(",").filter(Boolean) : [];
  const billing = searchParams.get("billing") ?? "";
  const statusCsv = searchParams.get("status") ?? "";
  const statuses = statusCsv ? statusCsv.split(",").filter(Boolean) : [];
  const dateField = searchParams.get("dateField") ?? "subscribed";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";

  const [searchInput, setSearchInput] = useState(q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [data, setData] = useState<VaultListDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [planOptions, setPlanOptions] = useState<VaultPlanOption[]>([]);

  /** Write params; anything but explicit pagination resets to page 1
   *  (spec 3.4). */
  const updateParams = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!("page" in patch)) next.delete("page");
      router.replace(`${ADMIN_ROOT}/plan-vault?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Debounced search (300 ms), same URL-mirroring pattern as the ledger.
  useEffect(() => {
    setSearchInput(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onSearchChange = (value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (value === q) return;
      updateParams({ q: value });
    }, 300);
  };
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api${ADMIN_ROOT}/vault?${searchParams.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`vault ${res.status}`);
      setData((await res.json()) as VaultListDto);
    } catch (err) {
      console.error("[vault] load failed:", err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  useEffect(() => {
    void load();
  }, [load]);

  // Plan options for the multi-select + the update panel — small and
  // static enough to fetch once per mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api${ADMIN_ROOT}/vault/options`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { plans: VaultPlanOption[] };
        if (!cancelled) setPlanOptions(json.plans ?? []);
      } catch {
        /* options are additive — the page works without them */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Update slide-over: the ONLY write in the admin area. */
  const [updateRow, setUpdateRow] = useState<VaultRowDto | null>(null);
  const onUpdated = useCallback(() => {
    // Refresh from the server — no full page reload, but the table,
    // summary and badges all re-read the ONE effective-status function.
    void load();
  }, [load]);

  /* Active-filter chips + Clear. */
  const hasFilters =
    plans.length > 0 || billing !== "" || statuses.length > 0 || from !== "" || to !== "";
  const clearFilters = () => {
    const next = new URLSearchParams(searchParams.toString());
    for (const key of ["plan", "billing", "status", "from", "to", "dateField"]) next.delete(key);
    router.replace(`${ADMIN_ROOT}/plan-vault?${next.toString()}`, { scroll: false });
  };

  const togglePlan = (id: string) => {
    const set = new Set(plans);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    updateParams({ plan: [...set].join(",") });
  };
  const toggleStatus = (value: VaultStatus) => {
    const set = new Set(statuses);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    updateParams({ status: [...set].join(",") });
  };

  const sortHeader = (field: SortField, label: string, numeric = false) => {
    const active = sort === field;
    return (
      <th scope="col" className="px-4 py-2.5">
        <button
          type="button"
          onClick={() => updateParams({ sort: field, dir: active && dir === "desc" ? "asc" : "desc" })}
          className={
            "inline-flex items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
            (active ? "text-[var(--sea-800)]" : "hover:text-foreground") +
            (numeric ? " tabular-nums" : "")
          }
          aria-label={`Sort by ${label}`}
        >
          {label}
          {active &&
            (dir === "asc" ? (
              <ArrowUp className="h-3 w-3" aria-hidden={true} />
            ) : (
              <ArrowDown className="h-3 w-3" aria-hidden={true} />
            ))}
        </button>
      </th>
    );
  };

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  // Compact numbered-page window: 1 … around current … last.
  const pageNumbers = useMemo(() => {
    const out: (number | "…")[] = [];
    const push = (n: number | "…") => out.push(n);
    if (pageCount <= 7) for (let i = 1; i <= pageCount; i++) push(i);
    else {
      push(1);
      if (page > 3) push("…");
      for (let i = Math.max(2, page - 1); i <= Math.min(pageCount - 1, page + 1); i++) push(i);
      if (page < pageCount - 2) push("…");
      push(pageCount);
    }
    return out;
  }, [page, pageCount]);

  const presetValue = useMemo(() => {
    if (!from && !to) return "";
    const { y, m, d } = tzTodayParts();
    const today = isoDate(y, m, d);
    if (from === today && to === today) return "today";
    if (from === isoDate(y, m, 1) && to === today) return "this-month";
    if (!to || to === today) {
      const t = new Date(`${today}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() - 6);
      if (from === isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())) return "7d";
      const t30 = new Date(`${today}T00:00:00Z`);
      t30.setUTCDate(t30.getUTCDate() - 29);
      if (from === isoDate(t30.getUTCFullYear(), t30.getUTCMonth() + 1, t30.getUTCDate())) return "30d";
    }
    return "custom";
  }, [from, to]);

  return (
    <div className="space-y-4">
      {/* Light header row, sea-blue title (spec Part 3). */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-[var(--sea-800)]">Plan Vault</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            One row per subscription record — search, filters and paging run on the server.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshIcon spinning={loading} />
          Refresh
        </Button>
      </div>

      {/* Controls: search, filters, date field + presets. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden={true} />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search name, email, phone, plan…"
            aria-label="Search subscriptions"
            className="h-9 w-full rounded-md border border-input bg-transparent pl-8 pr-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-72"
          />
        </div>

        {/* Plan multi-select from the plans table */}
        <Popover>
          <PopoverTrigger
            className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring hover:bg-muted/50"
            aria-label="Filter by plan"
          >
            Plans{plans.length > 0 ? ` (${plans.length})` : ""}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-2">
            {planOptions.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">
                No plans yet — they appear here from the plans table.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {planOptions.map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60">
                    <Checkbox className="mt-0.5" checked={plans.includes(p.id)} onCheckedChange={() => togglePlan(p.id)} aria-label={p.name} />
                    {/* Name + description from the same plans.tagline row
                        the public pricing cards render — one source. */}
                    <span className="min-w-0">
                      <span className="block font-medium">{p.name}</span>
                      {p.tagline && (
                        <span className="block truncate text-xs text-muted-foreground" title={p.tagline}>
                          {p.tagline}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>

        <label className="sr-only" htmlFor="vault-billing">Billing cycle</label>
        <select
          id="vault-billing"
          value={billing}
          onChange={(e) => updateParams({ billing: e.target.value })}
          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring"
        >
          <option value="">All billing</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>

        {/* Status multi-select — effective status, same function as the badges */}
        <Popover>
          <PopoverTrigger
            className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring hover:bg-muted/50"
            aria-label="Filter by status"
          >
            Status{statuses.length > 0 ? ` (${statuses.length})` : ""}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-2">
            <div className="flex flex-col gap-1">
              {STATUS_OPTIONS.map((s) => (
                <label key={s.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60">
                  <Checkbox
                    checked={statuses.includes(s.value)}
                    onCheckedChange={() => toggleStatus(s.value)}
                    aria-label={s.label}
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <label className="sr-only" htmlFor="vault-date-field">Date field</label>
        <select
          id="vault-date-field"
          value={dateField}
          onChange={(e) => updateParams({ dateField: e.target.value === "subscribed" ? "" : e.target.value })}
          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring"
        >
          {DATE_FIELD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="vault-preset">Date preset</label>
        <select
          id="vault-preset"
          value={presetValue}
          onChange={(e) => {
            const r = presetRange(e.target.value);
            if (r) updateParams({ from: r.from, to: r.to });
            else if (e.target.value === "") updateParams({ from: "", to: "" });
            // "custom" keeps the current bounds for the date inputs below
          }}
          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring"
        >
          <option value="">Any dates</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="this-month">This month</option>
          <option value="last-month">Last month</option>
          <option value="custom">Custom</option>
        </select>

        {(presetValue === "custom" || from || to) && (
          <>
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => updateParams({ from: e.target.value })}
              aria-label="From date"
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => updateParams({ to: e.target.value })}
              aria-label="To date"
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring"
            />
          </>
        )}

        {hasFilters && (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            <X className="h-3.5 w-3.5" aria-hidden={true} />
            Clear filters
          </Button>
        )}
      </div>

      {/* Active-filter chips */}
      {hasFilters && (
        <div className="flex flex-wrap items-center gap-1.5">
          {plans.map((p) => (
            <FilterChip key={`p-${p}`} label={planOptions.find((o) => o.id === p)?.name ?? p} onRemove={() => togglePlan(p)} />
          ))}
          {billing && (
            <FilterChip label={billing === "monthly" ? "Monthly" : "Yearly"} onRemove={() => updateParams({ billing: "" })} />
          )}
          {statuses.map((s) => (
            <FilterChip
              key={`s-${s}`}
              label={STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s}
              onRemove={() => toggleStatus(s as VaultStatus)}
            />
          ))}
          {(from || to) && (
            <FilterChip
              label={`${DATE_FIELD_OPTIONS.find((o) => o.value === dateField)?.label ?? "Date"}: ${from || "…"} → ${to || "…"}`}
              onRemove={() => updateParams({ from: "", to: "" })}
            />
          )}
        </div>
      )}

      {/* Range summary strip — across ALL matching rows, same request */}
      {data && !error && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SummaryTile
            label="Subscriptions in range"
            value={data.summary.subscriptionsInRange}
            loading={loading}
          />
          <SummaryTile label="Unique customers subscribed" value={data.summary.uniqueCustomers} loading={loading} />
          <SummaryTile label="New customer registrations" value={data.summary.newRegistrationsInRange} loading={loading} />
        </div>
      )}

      {/* Table */}
      <section className="rounded-xl border border-border bg-card">
        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-destructive/40 bg-card/40 p-10 text-center">
            <p className="text-sm font-medium text-muted-foreground">Couldn’t load subscriptions</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={CreditCard}
              title={hasFilters || q ? "No subscriptions match these filters" : "No subscription records yet"}
              hint={
                hasFilters || q
                  ? "Adjust the search or clear the filters to see more."
                  : "Rows appear as soon as customers start trials or subscribe. (If the billing migrations aren’t applied yet this view is legitimately empty.)"
              }
              action={
                hasFilters || q ? (
                  <Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Subscriptions, page {page} — {total.toLocaleString()} records matching
              </caption>
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-[var(--sea-200)] text-left text-xs font-medium text-muted-foreground">
                  <th scope="col" className="px-4 py-2.5">Customer</th>
                  {sortHeader("plan", "Plan")}
                  {sortHeader("created", "Subscribed on")}
                  {sortHeader("expires", "Expires on")}
                  {sortHeader("amount", "Amount", true)}
                  <th scope="col" className="px-4 py-2.5">Billing</th>
                  <th scope="col" className="px-4 py-2.5">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr
                    key={r.subscriptionId}
                    className="border-b border-border/60 transition-colors last:border-0 hover:bg-[var(--sea-100)]/50"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <InitialsAvatar name={r.customer.name} />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">{r.customer.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{r.customer.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`${ADMIN_ROOT}/member-ledger?plan=${encodeURIComponent(r.planName)}`}
                        title="View these customers in the Member Ledger"
                        className="inline-flex rounded-full border border-[var(--sea-200)] bg-[var(--sea-50)] px-2.5 py-0.5 text-xs font-medium text-[var(--sea-800)] underline-offset-4 transition-colors hover:bg-[var(--sea-100)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {r.planName}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {formatDay(r.subscribedOn)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <p className="text-foreground">{formatDay(r.expiresOn)}</p>
                      <p className="text-xs text-muted-foreground">{expiryHint(r.expiresOn)}</p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-foreground">
                      {formatInr(r.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary" className="bg-[var(--sea-100)] text-[var(--sea-800)]">
                        {r.billingCycle === "yearly" ? "Yearly" : "Monthly"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <VaultStatusBadge status={r.status} />
                        <PaymentStateLine state={r.paymentState} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          href={`${ADMIN_ROOT}/plan-vault/${r.subscriptionId}`}
                          className="inline-flex h-8 items-center rounded-md border border-input bg-transparent px-3 text-sm font-medium shadow-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Subscription
                        </Link>
                        <button
                          type="button"
                          onClick={() => setUpdateRow(r)}
                          className="inline-flex h-8 items-center rounded-md bg-[var(--sea-800)] px-3 text-sm font-medium text-white shadow-xs transition-colors hover:bg-[var(--sea-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Update
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Truncation honesty (scan cap) */}
      {data?.truncated && !loading && !error && (
        <p className="text-xs text-[var(--sea-muted)]">
          Showing results from the first {VAULT_SCAN_CAP.toLocaleString("en-IN")} subscription records — narrow the
          date range to reach older ones.
        </p>
      )}

      {/* Paging: "Showing 26 to 50 of 312", page size, numbered pages */}
      {!loading && !error && data && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p aria-live="polite">
            Showing {rangeStart.toLocaleString()} to {rangeEnd.toLocaleString()} of{" "}
            {total.toLocaleString()}
          </p>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="vault-page-size">Rows per page</label>
            <select
              id="vault-page-size"
              value={pageSize}
              onChange={(e) => updateParams({ pageSize: e.target.value === String(DEFAULT_PAGE_SIZE) ? "" : e.target.value })}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring"
            >
              {VAULT_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => updateParams({ page: String(page - 1) })}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden={true} />
            </Button>
            {pageNumbers.map((n, i) =>
              n === "…" ? (
                <span key={`e${i}`} className="px-1 text-muted-foreground">…</span>
              ) : (
                <button
                  key={n}
                  type="button"
                  onClick={() => updateParams({ page: n === 1 ? "" : String(n) })}
                  aria-current={n === page ? "page" : undefined}
                  className={
                    "size-8 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                    (n === page
                      ? "bg-[var(--sea-800)] text-white"
                      : "border border-input hover:bg-muted")
                  }
                >
                  {n}
                </button>
              ),
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pageCount}
              onClick={() => updateParams({ page: String(page + 1) })}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" aria-hidden={true} />
            </Button>
          </div>
        </div>
      )}

      {/* The ONLY write in the admin area */}
      <SubscriptionUpdatePanel
        subscription={updateRow}
        plans={planOptions}
        onClose={() => setUpdateRow(null)}
        onUpdated={onUpdated}
      />
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--sea-100)] py-0.5 pr-1 pl-2.5 text-xs font-medium text-[var(--sea-800)]">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="rounded-full p-0.5 transition-colors hover:bg-[var(--sea-200)]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3 w-3" aria-hidden={true} />
      </button>
    </span>
  );
}

function SummaryTile({ label, value, loading }: { label: string; value: number; loading: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {loading ? (
        <Skeleton className="mt-1 h-7 w-16" />
      ) : (
        <p className="mt-0.5 text-2xl font-bold tabular-nums text-[var(--sea-800)]">{value.toLocaleString()}</p>
      )}
    </div>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  // Inline to keep the icon spin consistent with Pulse's refresh.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? "h-4 w-4 animate-spin" : "h-4 w-4"}
      aria-hidden={true}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

/** useSearchParams needs a Suspense boundary to keep the page
 *  prerenderable (same pattern as Member Ledger). */
export function PlanVault() {
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full rounded-xl" />}>
      <VaultInner />
    </Suspense>
  );
}
