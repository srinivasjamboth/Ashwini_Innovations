"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Search, Users } from "lucide-react";
import type { MemberPage } from "@/lib/admin/metrics";
import { ADMIN_ROOT, LEDGER_PAGE_SIZE } from "@/lib/admin/constants";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import { Button } from "@/components/ui/button";
import { SubscriptionBadge, formatRegistered } from "./admin-format";

/**
 * Member Ledger — server-paginated customer list (25/page, total
 * count, DB-side search). All view state lives in the URL query
 * string so any view is shareable and refresh-safe; this component
 * mirrors the URL into its controls and refetches when it changes.
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

  const [searchInput, setSearchInput] = useState(q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [data, setData] = useState<MemberPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

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

  // Debounced search: URL is the source of truth, so typing schedules
  // a param write instead of firing a fetch per keystroke.
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
    }, 350);
  };
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api${ADMIN_ROOT}/members?${searchParams.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`members ${res.status}`);
      setData((await res.json()) as MemberPage);
    } catch (err) {
      console.error("[ledger] load failed:", err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Member Ledger</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every registered customer — teammates inside their accounts are not counted.
        </p>
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

      {/* Table */}
      <section className="rounded-xl border border-border bg-card">
        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <p className="text-sm font-medium text-muted-foreground">Couldn’t load the ledger</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={q || subscription || plan || status ? "No members match this view" : "No registered customers yet"}
              hint={q ? "Try a shorter search term or clear the filters." : "They appear here as soon as anyone registers."}
              icon={Users}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Member ledger, page {data.page} — {data.total.toLocaleString()} customers total
              </caption>
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
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
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.userId} className="border-b border-border/60 last:border-0">
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pagination + total */}
      {!loading && !error && data && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>
            {total.toLocaleString()} customer{total === 1 ? "" : "s"} · page {data.page} of {pageCount.toLocaleString()}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={data.page <= 1}
              onClick={() => updateParams({ page: String(data.page - 1) })}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden={true} />
              Prev
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={data.page >= pageCount}
              onClick={() => updateParams({ page: String(data.page + 1) })}
            >
              Next
              <ChevronRight className="h-4 w-4" aria-hidden={true} />
            </Button>
          </div>
        </div>
      )}
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
