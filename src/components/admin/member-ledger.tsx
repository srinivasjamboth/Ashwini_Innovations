"use client";

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, ExternalLink, Search, UserPlus, Users } from "lucide-react";
import type { MemberDetail, MemberPage } from "@/lib/admin/metrics";
import {
  ADMIN_ROOT,
  ADMIN_TIMEZONE,
  LEDGER_DEFAULT_PAGE_SIZE,
  LEDGER_PAGE_SIZE_STORAGE_KEY,
  LEDGER_PAGE_SIZES,
} from "@/lib/admin/constants";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import { Button } from "@/components/ui/button";
import { SubscriptionBadge, formatRegistered } from "./admin-format";
import { Pagination } from "./pagination";
import { usePagedResource } from "./use-paged-resource";
import { AddUserPanel } from "./add-user-panel";

const isValidSize = (n: number): boolean =>
  (LEDGER_PAGE_SIZES as readonly number[]).includes(n);

/** Calendar "today" as YYYY-MM-DD cut in the admin timezone. */
function todayInTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ADMIN_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Shift a YYYY-MM-DD calendar day by `days` (negative = earlier). */
function shiftDay(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** First day of the current calendar month / year, in the admin tz. */
function startOfMonth(): string {
  return `${todayInTz().slice(0, 7)}-01`;
}
function startOfYear(): string {
  return `${todayInTz().slice(0, 4)}-01-01`;
}

type PresetKey = "all" | "7d" | "30d" | "mtd" | "ytd";
const PRESETS: { key: PresetKey; label: string; from: () => string | null }[] = [
  { key: "all", label: "All time", from: () => null },
  { key: "7d", label: "Last 7 days", from: () => shiftDay(todayInTz(), -6) },
  { key: "30d", label: "Last 30 days", from: () => shiftDay(todayInTz(), -29) },
  { key: "mtd", label: "This month", from: () => startOfMonth() },
  { key: "ytd", label: "This year", from: () => startOfYear() },
];

/** Which preset (if any) the current from/to window matches exactly. */
function activePreset(from: string | null, to: string | null): PresetKey | null {
  const today = todayInTz();
  if (!from && !to) return "all";
  if (from === shiftDay(today, -6) && to === today) return "7d";
  if (from === shiftDay(today, -29) && to === today) return "30d";
  if (from === startOfMonth() && to === today) return "mtd";
  if (from === startOfYear() && to === today) return "ytd";
  return null;
}

/**
 * Member Ledger — server-paginated customer list. All view state lives in
 * the URL query string so any view is shareable and refresh-safe. Now
 * reuses the SHARED <Pagination> + paging effect that the Pulse fresh-users
 * table uses (spec Part 1B: "one component for both tables, no copy"):
 * entries selector (10/25/50/100, default 25, remembered in
 * localStorage), "Showing 26 to 50 of 112", first/prev/numbered-ellipses/
 * next/last, compact below 640 px, out-of-order responses dropped, an
 * `aria-live` page announcement, a stable height while paging, and a fade
 * in of new rows (off under prefers-reduced-motion). Registered-date
 * presets are applied DB-side (Asia/Kolkata) so they compose with search
 * and pagination.
 */
function LedgerInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const q = searchParams.get("q") ?? "";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const sort = searchParams.get("sort") === "oldest" ? "oldest" : "newest";
  const subscription = searchParams.get("subscription") ?? "";
  const plan = searchParams.get("plan") ?? "";
  const status = searchParams.get("status") ?? "";
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  // Start on the default size, then adopt localStorage / the URL after
  // mount — reading storage during the initial render would risk a
  // hydration mismatch (same reason the fresh-users table defers it).
  const [storedSize, setStoredSize] = useState<number>(LEDGER_DEFAULT_PAGE_SIZE);
  useEffect(() => {
    const urlSize = Number(searchParams.get("pageSize"));
    if (isValidSize(urlSize)) return; // URL wins
    try {
      const saved = Number(localStorage.getItem(LEDGER_PAGE_SIZE_STORAGE_KEY));
      if (isValidSize(saved)) setStoredSize(saved);
    } catch {
      /* private mode — keep the default */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urlSize = Number(searchParams.get("pageSize"));
  const pageSize = isValidSize(urlSize) ? urlSize : storedSize;

  const [searchInput, setSearchInput] = useState(q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  /** Write one or more params, always resetting to page 1 unless the
   *  caller is the pagination itself. */
  const updateParams = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!("page" in patch)) next.delete("page");
      router.replace(`${ADMIN_ROOT}/member-ledger?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Debounced search: the URL is the source of truth, so typing schedules
  // a param write instead of firing a fetch per keystroke (spec: 300 ms).
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

  // Build the fetch URL from the same params the server understands, so
  // the shared hook can drop out-of-order responses by URL identity.
  const url = useMemo(() => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    if (sort !== "newest") sp.set("sort", sort);
    if (subscription) sp.set("subscription", subscription);
    if (plan) sp.set("plan", plan);
    if (status) sp.set("status", status);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    return `/api${ADMIN_ROOT}/members?${sp.toString()}`;
  }, [q, page, pageSize, sort, subscription, plan, status, from, to]);

  const { data, loading, error, retry, version } = usePagedResource<MemberPage>(url);

  // Expandable rows (spec Part 1): the detail payload is fetched lazily,
  // only for the row the admin opens, and cached per customer for the
  // lifetime of the view. Paging away resets nothing — reopening reuses
  // the cache; a fresh page keeps the set but rows not on it simply
  // collapse.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [details, setDetails] = useState<Record<string, MemberDetail>>({});
  const [detailBusy, setDetailBusy] = useState<Record<string, boolean>>({});
  const [detailError, setDetailError] = useState<Record<string, boolean>>({});

  const loadDetail = useCallback(async (userId: string) => {
    setDetailBusy((b) => ({ ...b, [userId]: true }));
    setDetailError((e) => ({ ...e, [userId]: false }));
    try {
      const res = await fetch(`/api${ADMIN_ROOT}/members/${userId}/detail`, { cache: "no-store" });
      if (!res.ok) throw new Error(`detail ${res.status}`);
      const json = (await res.json()) as MemberDetail;
      setDetails((d) => ({ ...d, [userId]: json }));
    } catch {
      setDetailError((e) => ({ ...e, [userId]: true }));
    } finally {
      setDetailBusy((b) => ({ ...b, [userId]: false }));
    }
  }, []);

  const toggleRow = (userId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
        if (!details[userId] && !detailBusy[userId]) void loadDetail(userId);
      }
      return next;
    });
  };

  const retryDetail = (userId: string) => void loadDetail(userId);

  const changeSize = (n: number) => {
    setStoredSize(n);
    try {
      localStorage.setItem(LEDGER_PAGE_SIZE_STORAGE_KEY, String(n));
    } catch {
      /* in-memory only */
    }
    // A size change resets to page 1 (spec).
    updateParams({ pageSize: String(n), page: "" });
  };

  const applyPreset = (key: PresetKey) => {
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset) return;
    const f = preset.from();
    const t = key === "all" ? null : todayInTz();
    updateParams({ from: f ?? "", to: t ?? "" });
  };

  const hasFilters = Boolean(q || subscription || plan || status || from || to);
  const clearFilters = () =>
    updateParams({ q: "", subscription: "", plan: "", status: "", from: "", to: "" });

  const total = data?.total ?? 0;
  const rows = data?.rows ?? [];
  const firstLoad = loading && !data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Member Ledger</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every registered customer — teammates inside their accounts are not counted.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setAddOpen(true)}
          className="bg-[var(--sea-800)] text-white hover:bg-[var(--sea-700)]"
        >
          <UserPlus className="h-4 w-4" aria-hidden={true} />
          Add new user
        </Button>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden={true} />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search name, email, phone…"
            aria-label="Search members"
            className="h-9 w-full rounded-md border border-input bg-transparent pl-8 pr-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-64"
          />
        </div>

        <label className="sr-only" htmlFor="ledger-subscription">Subscription type</label>
        <select
          id="ledger-subscription"
          value={subscription}
          onChange={(e) => updateParams({ subscription: e.target.value })}
          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring"
        >
          <option value="">All subscriptions</option>
          <option value="free">Free</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>

        <label className="sr-only" htmlFor="ledger-plan">Plan</label>
        <select
          id="ledger-plan"
          value={plan}
          onChange={(e) => updateParams({ plan: e.target.value })}
          disabled={data ? !data.subscriptionsAvailable : loading}
          title={data && !data.subscriptionsAvailable ? "No plans table in this schema yet" : undefined}
          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring disabled:opacity-50"
        >
          <option value="">All plans</option>
        </select>

        <label className="sr-only" htmlFor="ledger-status">Subscription status</label>
        <select
          id="ledger-status"
          value={status}
          onChange={(e) => updateParams({ status: e.target.value })}
          disabled={data ? !data.subscriptionsAvailable : loading}
          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring disabled:opacity-50"
        >
          <option value="">Any status</option>
        </select>

        <label className="sr-only" htmlFor="ledger-sort">Sort by registered date</label>
        <select
          id="ledger-sort"
          value={sort}
          onChange={(e) => updateParams({ sort: e.target.value === "oldest" ? "oldest" : "" })}
          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>

      {/* Registered-date presets (applied DB-side in Asia/Kolkata) */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Registered:</span>
        {PRESETS.map((p) => {
          const isActive = activePreset(from, to) === p.key;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => applyPreset(p.key)}
              aria-pressed={isActive}
              className={
                "h-7 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                (isActive
                  ? "border-transparent bg-[var(--sea-800)] text-white"
                  : "border-input text-muted-foreground hover:bg-muted")
              }
            >
              {p.label}
            </button>
          );
        })}

        <label className="ml-1 text-xs font-medium text-muted-foreground" htmlFor="ledger-from">
          From
        </label>
        <input
          id="ledger-from"
          type="date"
          value={from ?? ""}
          max={to ?? undefined}
          onChange={(e) => updateParams({ from: e.target.value })}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring"
        />
        <label className="text-xs font-medium text-muted-foreground" htmlFor="ledger-to">
          To
        </label>
        <input
          id="ledger-to"
          type="date"
          value={to ?? ""}
          min={from ?? undefined}
          onChange={(e) => updateParams({ to: e.target.value })}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring"
        />
        {hasFilters && (
          <Button size="sm" variant="ghost" onClick={clearFilters} className="h-8 px-2 text-xs">
            Clear filters
          </Button>
        )}
      </div>

      {/* Table */}
      <section className="rounded-xl border border-border bg-card">
        {firstLoad ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : error && !data ? (
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <p className="text-sm font-medium text-muted-foreground">Couldn&rsquo;t load the ledger</p>
            <Button size="sm" variant="outline" onClick={retry}>Retry</Button>
          </div>
        ) : !data || rows.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={hasFilters ? "No members match this view" : "No registered customers yet"}
              hint={
                hasFilters
                  ? "Try a shorter search term or clear the filters."
                  : "They appear here as soon as anyone registers."
              }
              icon={Users}
              action={
                hasFilters ? (
                  <Button size="sm" variant="outline" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            {error && (
              <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-5 py-2.5 text-sm text-muted-foreground">
                <span>Couldn&rsquo;t refresh this page.</span>
                <Button size="sm" variant="outline" onClick={retry}>
                  Retry
                </Button>
              </div>
            )}
            {/* Stable height keeps the section from jumping while paging;
                rows dim during a fetch and fade in when new ones land
                (the fade is disabled under prefers-reduced-motion). */}
            <div className="overflow-x-auto" style={{ minHeight: "320px" }}>
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Member ledger, page {data.page} — {total.toLocaleString()} customers total
                </caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                    <th scope="col" className="w-9 px-2 py-2.5">
                      <span className="sr-only">Expand</span>
                    </th>
                    <th scope="col" className="px-4 py-2.5">Name</th>
                    <th scope="col" className="px-4 py-2.5">Email</th>
                    <th scope="col" className="px-4 py-2.5">Phone</th>
                    <th scope="col" className="px-4 py-2.5">Registered</th>
                    <th scope="col" className="px-4 py-2.5">Plan</th>
                    <th scope="col" className="px-4 py-2.5">Subscription</th>
                    <th scope="col" className="px-4 py-2.5">Status</th>
                    <th scope="col" className="px-4 py-2.5">Renews/Expires</th>
                  </tr>
                </thead>
                <tbody
                  key={version}
                  className={loading ? "admin-paged-fade opacity-60" : "admin-paged-fade"}
                >
                  {rows.map((r) => {
                    const isOpen = expanded.has(r.userId);
                    const detail = details[r.userId];
                    return (
                      <Fragment key={r.userId}>
                        <tr className="border-b border-border/60 hover:bg-[var(--sea-100)]/40">
                          <td className="px-2 py-3 align-middle">
                            <button
                              type="button"
                              onClick={() => toggleRow(r.userId)}
                              aria-expanded={isOpen}
                              aria-label={isOpen ? `Collapse ${r.fullName || r.email}` : `Details for ${r.fullName || r.email}`}
                              className="inline-flex size-6 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" aria-hidden={true} />
                              ) : (
                                <ChevronRight className="h-4 w-4" aria-hidden={true} />
                              )}
                            </button>
                          </td>
                          <td className="px-4 py-3 font-medium whitespace-nowrap text-foreground">
                            {r.fullName || "—"}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{r.email}</td>
                          <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{r.phone || "—"}</td>
                          <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                            {formatRegistered(r.registeredAt)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{r.planName || "—"}</td>
                          <td className="px-4 py-3">
                            <SubscriptionBadge type={r.subscriptionType} />
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                            {r.subscriptionStatus || "—"}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                            {r.renewsOrExpiresAt ? formatRegistered(r.renewsOrExpiresAt) : "—"}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-border/60 bg-[var(--sea-50)]/60">
                            <td colSpan={9} className="px-4 py-4">
                              <RowDetail
                                loading={!!detailBusy[r.userId] && !detail}
                                error={!!detailError[r.userId]}
                                detail={detail}
                                userId={r.userId}
                                onRetry={retryDetail}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="border-t border-border/60 px-5 py-3">
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={total}
                pageSizes={LEDGER_PAGE_SIZES}
                pageSizeLabel="Members per page"
                onPageSizeChange={changeSize}
                onPageChange={(n) => updateParams({ page: String(n) })}
              />
            </div>
          </>
        )}
      </section>

      <AddUserPanel
        open={addOpen}
        onClose={() => setAddOpen(false)}
        // Re-fetch the table itself: the rows come from usePagedResource's
        // client fetch, which router.refresh() does NOT retrigger — only
        // the hook's retry does. Without this the new customer stays
        // invisible until a filter change or manual reload.
        onCreated={retry}
      />
    </div>
  );
}

/** One labelled figure inside the expanded detail panel. */
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-foreground" title={typeof children === "string" ? children : undefined}>
        {children}
      </dd>
    </div>
  );
}

/** WhatsApp connection pill — allowed status colors only (spec Part 5). */
function WhatsAppStatusPill({ status }: { status: MemberDetail["whatsappStatus"] }) {
  const map = {
    connected: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    disconnected: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    none: "bg-muted text-muted-foreground",
  } as const;
  const label = status === "none" ? "Not connected" : status === "connected" ? "Connected" : "Disconnected";
  return (
    <span className={"inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium " + map[status]}>
      {label}
    </span>
  );
}

/**
 * Lazy detail panel shown under an opened row: account name, connected
 * WhatsApp number + status, last active, contacts, campaigns, team
 * members, plus the Subscription quick action (spec Part 3) that deep-
 * links the EXISTING Plan Vault detail page — never a duplicate view.
 */
function RowDetail({
  loading,
  error,
  detail,
  userId,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  detail?: MemberDetail;
  userId: string;
  onRetry: (userId: string) => void;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (error && !detail) {
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>Couldn&rsquo;t load details.</span>
        <Button size="sm" variant="outline" onClick={() => onRetry(userId)}>
          Retry
        </Button>
      </div>
    );
  }
  if (!detail) return null;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Account">{detail.accountName ?? "—"}</Stat>
        <Stat label="WhatsApp">
          <span className="flex flex-wrap items-center gap-1.5">
            <WhatsAppStatusPill status={detail.whatsappStatus} />
            {detail.whatsappNumberId && (
              <span className="font-mono text-xs text-muted-foreground">{detail.whatsappNumberId}</span>
            )}
          </span>
        </Stat>
        <Stat label="Last active">
          {detail.lastActiveAt ? formatRegistered(detail.lastActiveAt) : "—"}
        </Stat>
        <Stat label="Contacts">{detail.contacts.toLocaleString("en-IN")}</Stat>
        <Stat label="Campaigns">{detail.campaigns.toLocaleString("en-IN")}</Stat>
        <Stat label="Team members">{detail.teamMembers.toLocaleString("en-IN")}</Stat>
      </dl>

      {/* Quick actions: the subscription deep-link, plus a details retry
          when the last fetch failed. */}
      <div className="flex flex-wrap items-center gap-3">
        {detail.latestSubscriptionId ? (
          <a
            href={`${ADMIN_ROOT}/plan-vault/${detail.latestSubscriptionId}?from=member-ledger`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--sea-700)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          >
            <ExternalLink className="h-4 w-4" aria-hidden={true} />
            View subscription
          </a>
        ) : (
          <span className="text-sm text-muted-foreground">No subscription yet</span>
        )}
        {error && (
          <Button size="sm" variant="ghost" onClick={() => onRetry(userId)} className="h-7 px-2 text-xs">
            Refresh details
          </Button>
        )}
      </div>
    </div>
  );
}

/** useSearchParams needs a Suspense boundary to keep the page
 *  prerenderable (same pattern as the client /login page). */
export function MemberLedger() {
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full rounded-xl" />}>
      <LedgerInner />
    </Suspense>
  );
}
