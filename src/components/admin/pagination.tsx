"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared pagination — the ONE pager used by both the Member Ledger table
 * and the Pulse fresh-users table (spec Part 1B: "one component for both
 * tables, no copy"). Presentational only: the caller owns the state
 * (page / pageSize / total) and the URL params, so this component never
 * reads localStorage and can't cause a hydration mismatch.
 *
 * Layout (matches the existing Plan Vault pager so the admin area feels
 * uniform): "Showing 26 to 50 of 312" on the left; on the right an
 * optional entries selector, then ⏮ ◀ numbered-with-ellipses ▶ ⏭. Below
 * 640 px (`sm`) the numbered run collapses to a compact "Page 2 of 6".
 */
export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  /** Called when the user flips to another page. */
  onPageChange: (page: number) => void;
  /** When provided, an entries-per-page selector is rendered. */
  pageSizes?: readonly number[];
  pageSizeLabel?: string;
  onPageSizeChange?: (size: number) => void;
  className?: string;
}

/** Compact numbered window: 1 … (around current) … last — same rule as
 *  the Plan Vault, so both pagers reveal/ellipsize identically. */
function buildPageNumbers(page: number, pageCount: number): (number | "…")[] {
  const out: (number | "…")[] = [];
  if (pageCount <= 7) {
    for (let i = 1; i <= pageCount; i++) out.push(i);
    return out;
  }
  out.push(1);
  if (page > 3) out.push("…");
  for (let i = Math.max(2, page - 1); i <= Math.min(pageCount - 1, page + 1); i++) out.push(i);
  if (page < pageCount - 2) out.push("…");
  out.push(pageCount);
  return out;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  pageSizes,
  pageSizeLabel = "Rows per page",
  onPageSizeChange,
  className,
}: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);
  const numbers = useMemo(() => buildPageNumbers(page, pageCount), [page, pageCount]);

  const go = (n: number) => {
    const clamped = Math.min(Math.max(1, n), pageCount);
    if (clamped !== page) onPageChange(clamped);
  };

  const pageBtn = (n: number) => (
    <button
      key={n}
      type="button"
      onClick={() => go(n)}
      aria-current={n === page ? "page" : undefined}
      className={cn(
        "size-8 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        n === page ? "bg-[var(--sea-800)] text-white" : "border border-input hover:bg-muted",
      )}
    >
      {n}
    </button>
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground",
        className,
      )}
    >
      <p aria-live="polite">
        Showing {rangeStart.toLocaleString()} to {rangeEnd.toLocaleString()} of{" "}
        {total.toLocaleString()}
      </p>

      <div className="flex items-center gap-2">
        {pageSizes && onPageSizeChange && (
          <>
            <label className="sr-only" htmlFor={`pager-size-${pageSizeLabel.replace(/\s+/g, "-").toLowerCase()}`}>
              {pageSizeLabel}
            </label>
            <select
              id={`pager-size-${pageSizeLabel.replace(/\s+/g, "-").toLowerCase()}`}
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring"
            >
              {pageSizes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </>
        )}

        {/* Compact pager (below sm): prev / "Page x of y" / next */}
        <div className="flex items-center gap-1 sm:hidden">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => go(page - 1)} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" aria-hidden={true} />
          </Button>
          <span className="px-1 tabular-nums">
            Page {page.toLocaleString()} of {pageCount.toLocaleString()}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pageCount}
            onClick={() => go(page + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" aria-hidden={true} />
          </Button>
        </div>

        {/* Full pager (sm and up): first / prev / numbered+ellipses / next / last */}
        <div className="hidden items-center gap-1 sm:flex">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => go(1)} aria-label="First page">
            <ChevronsLeft className="h-4 w-4" aria-hidden={true} />
          </Button>
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => go(page - 1)} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" aria-hidden={true} />
          </Button>
          {numbers.map((n, i) =>
            n === "…" ? (
              <span key={`e${i}`} className="px-1 text-muted-foreground">
                …
              </span>
            ) : (
              pageBtn(n)
            ),
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pageCount}
            onClick={() => go(page + 1)}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" aria-hidden={true} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pageCount}
            onClick={() => go(pageCount)}
            aria-label="Last page"
          >
            <ChevronsRight className="h-4 w-4" aria-hidden={true} />
          </Button>
        </div>
      </div>
    </div>
  );
}
