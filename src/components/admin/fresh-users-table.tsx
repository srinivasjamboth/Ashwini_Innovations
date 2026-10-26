"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { UserPlus } from "lucide-react";
import type { FreshUser } from "@/lib/admin/metrics";
import {
  ADMIN_ROOT,
  USERS_DEFAULT_PAGE_SIZE,
  USERS_PAGE_PARAM,
  USERS_PAGE_SIZE_PARAM,
  USERS_PAGE_SIZES,
  USERS_PAGE_SIZE_STORAGE_KEY,
} from "@/lib/admin/constants";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import { Button } from "@/components/ui/button";
import { Pagination } from "./pagination";
import { usePagedResource } from "./use-paged-resource";
import { SubscriptionBadge, formatRegistered } from "./admin-format";

interface UsersPage {
  rows: FreshUser[];
  total: number;
  page: number;
  pageSize: number;
  subscriptionsAvailable: boolean;
}

const isValidSize = (n: number): boolean =>
  (USERS_PAGE_SIZES as readonly number[]).includes(n);

/**
 * The Pulse "User Registrations" table, now server-paged (spec Part 1B
 * §4). Reads its own `usersPage` / `usersPageSize` URL params (never
 * clashing with other tables), remembers the entries size in localStorage,
 * reuses the SHARED <Pagination> + paging effect used by the Member
 * Ledger: stable height while loading, new rows fade in over 150 ms
 * (off under prefers-reduced-motion), out-of-order responses ignored,
 * `aria-live` page announcement, and a load error keeps the old rows and
 * offers Retry. Independent of the cards/chart bundle, so Pulse does not
 * get slower.
 */
function UsersTableInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const page = Math.max(1, Number(searchParams.get(USERS_PAGE_PARAM) ?? "1") || 1);

  // Start on the default size, then adopt localStorage / the URL after
  // mount — reading storage in the initial state would risk a hydration
  // mismatch (same reason the admin sidebar defers it).
  const [storedSize, setStoredSize] = useState<number>(USERS_DEFAULT_PAGE_SIZE);
  useEffect(() => {
    const fromUrl = Number(searchParams.get(USERS_PAGE_SIZE_PARAM));
    if (isValidSize(fromUrl)) return; // URL wins
    try {
      const saved = Number(localStorage.getItem(USERS_PAGE_SIZE_STORAGE_KEY));
      if (isValidSize(saved)) setStoredSize(saved);
    } catch {
      /* private mode — keep the default */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const urlSize = Number(searchParams.get(USERS_PAGE_SIZE_PARAM));
  const pageSize = isValidSize(urlSize) ? urlSize : storedSize;

  const url = useMemo(
    () =>
      `/api${ADMIN_ROOT}/pulse/users?${USERS_PAGE_PARAM}=${page}&${USERS_PAGE_SIZE_PARAM}=${pageSize}`,
    [page, pageSize],
  );

  const { data, loading, error, retry, version } = usePagedResource<UsersPage>(url);

  const writeParams = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (!v || v === "1") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(`${ADMIN_ROOT}?${qs}`, { scroll: false });
    },
    [router, searchParams],
  );

  const changeSize = (n: number) => {
    setStoredSize(n);
    try {
      localStorage.setItem(USERS_PAGE_SIZE_STORAGE_KEY, String(n));
    } catch {
      /* in-memory only */
    }
    // A size change resets to page 1 (spec).
    writeParams({ [USERS_PAGE_SIZE_PARAM]: String(n), [USERS_PAGE_PARAM]: "" });
  };

  const total = data?.total ?? 0;
  const rows = data?.rows ?? [];
  const firstLoad = loading && !data;

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">User Registrations</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            All customers, newest first
          </p>
        </div>
        <a
          href={`${ADMIN_ROOT}/member-ledger`}
          className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          View all
        </a>
      </header>

      {firstLoad ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : rows.length === 0 && !error ? (
        <div className="p-5">
          <EmptyState
            title="No registrations yet"
            hint="New customers show up here the moment they register."
            icon={UserPlus}
          />
        </div>
      ) : (
        <>
          {error && (
            <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-5 py-2.5 text-sm text-muted-foreground">
              <span>Couldn’t refresh this page.</span>
              <Button size="sm" variant="outline" onClick={retry}>
                Retry
              </Button>
            </div>
          )}
          {/* Stable height keeps the section from jumping while paging;
              existing rows dim during a fetch and fade in when new ones
              land (the fade is disabled under prefers-reduced-motion). */}
          <div className="overflow-x-auto" style={{ minHeight: "240px" }}>
            <table className="w-full text-sm">
              <caption className="sr-only">Most recent customer registrations</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                  <th scope="col" className="px-5 py-2.5">User</th>
                  <th scope="col" className="px-5 py-2.5">Registered</th>
                  <th scope="col" className="px-5 py-2.5">Subscription</th>
                </tr>
              </thead>
              <tbody
                key={version}
                className={loading ? "admin-paged-fade opacity-60" : "admin-paged-fade"}
              >
                {rows.map((u) => (
                  <tr key={u.userId} className="border-b border-border/60 last:border-0">
                    <td className="px-5 py-3">
                      <p className="font-medium text-foreground">{u.fullName || "—"}</p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-muted-foreground">
                      {formatRegistered(u.registeredAt)}
                    </td>
                    <td className="px-5 py-3">
                      <SubscriptionBadge type={u.subscriptionType} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="px-5 py-3">
            <Pagination
              page={data?.page ?? page}
              pageSize={pageSize}
              total={total}
              pageSizes={USERS_PAGE_SIZES}
              pageSizeLabel="Registrations per page"
              onPageSizeChange={changeSize}
              onPageChange={(n) => writeParams({ [USERS_PAGE_PARAM]: String(n) })}
            />
          </div>
        </>
      )}
    </section>
  );
}

/** useSearchParams needs a Suspense boundary to stay prerenderable. */
export function FreshUsersTable() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full rounded-xl" />}>
      <UsersTableInner />
    </Suspense>
  );
}
