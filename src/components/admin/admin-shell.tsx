"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, CreditCard, LogOut, Menu, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ADMIN_LOGIN_PATH, ADMIN_PAGES, BRAND_LOGO_SRC, BRAND_NAME } from "@/lib/admin/constants";

/** Sidebar icons keyed off ADMIN_PAGES[].key — labels/paths stay the
 *  single source of truth in constants; this only decorates them so the
 *  collapsed rail can identify each page. */
const PAGE_ICONS = {
  pulse: Activity,
  "member-ledger": Users,
  "plan-vault": CreditCard,
} as const;

/** Per-browser collapse preference (UI-only, same idea as the client
 *  sidebar's collapsed flag). */
const COLLAPSE_STORAGE_KEY = "ashwini:admin-sidebar-collapsed";

/**
 * Admin shell chrome: a sidebar containing exactly the three admin
 * pages plus Log out, a top header with the owner greeting, and a
 * mobile drawer (the sidebar collapses into it below lg).
 *
 * Colors: the sidebar is the fixed dark sea-900 from the admin palette
 * (var(--sea-900), tokenized in globals.css under html[data-admin]) —
 * deliberately not a theme surface, so it stays dark in both modes.
 * Everything else uses tokens; the admin layout forces
 * html[data-mode=light], so the content area is always white.
 *
 * Kept standalone on purpose — the client dashboard's <Sidebar> is
 * wired to useAuth/presence/notifications, none of which belong to
 * the owner area, and touching it would risk the client UI.
 */
export function AdminShell({
  ownerName,
  children,
}: {
  ownerName: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  // Always start expanded on the server pass, then restore the saved
  // preference after mount — reading localStorage in the initial state
  // would make the first client render differ from the SSR markup and
  // trip a hydration mismatch on the sidebar width/classes.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_STORAGE_KEY) === "true");
    } catch {
      /* private-mode etc. — stay expanded */
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
      } catch {
        /* in-memory state still updates for this tab */
      }
      return next;
    });
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/ashwini-control/logout", { method: "POST" });
    } catch {
      /* fall through — cookies get cleared client-side regardless */
    }
    window.location.href = ADMIN_LOGIN_PATH;
  };

  // `mini` renders the icon-rail variant (collapsed desktop sidebar);
  // the mobile drawer always gets the full expanded version.
  const nav = (mini: boolean) => (
    <nav aria-label="Admin" className="flex flex-1 flex-col gap-1 p-3">
      {ADMIN_PAGES.map((page) => {
        // Exact match only — "Pulse" sits at the ADMIN_ROOT prefix, so
        // a startsWith test would keep it active on every page.
        const active = pathname === page.path;
        const Icon = PAGE_ICONS[page.key];
        return (
          <Link
            key={page.key}
            href={page.path}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            title={mini ? page.label : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              mini && "justify-center px-2",
              active
                ? "bg-[var(--sea-700)] text-white"
                : "text-[var(--sea-200)]/80 hover:bg-white/10 hover:text-white",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden={true} />
            {mini ? <span className="sr-only">{page.label}</span> : page.label}
          </Link>
        )
      })}
      <div className="mt-auto border-t border-white/15 pt-3">
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          title={mini ? "Log out" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-[var(--sea-200)]/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sea-200)]/70 disabled:opacity-50",
            mini && "justify-center px-2",
          )}
        >
          <LogOut className="h-4 w-4 shrink-0" aria-hidden={true} />
          {mini ? (
            <span className="sr-only">Log out</span>
          ) : loggingOut ? (
            "Logging out…"
          ) : (
            "Log out"
          )}
        </button>
      </div>
    </nav>
  );

  const brand = (mini: boolean) => (
    <Link
      href={ADMIN_PAGES[0].path}
      className={cn("flex items-center gap-2.5 px-4 py-4", mini && "justify-center px-2")}
    >
      <img
        src={BRAND_LOGO_SRC}
        alt=""
        width={32}
        height={32}
        className="h-8 w-8 shrink-0 rounded-lg object-cover"
      />
      {mini ? (
        <span className="sr-only">{BRAND_NAME}</span>
      ) : (
        <span className="text-sm font-bold text-white">{BRAND_NAME}</span>
      )}
    </Link>
  );

  return (
    <div className="flex min-h-dvh bg-background">
      {/* Desktop sidebar — sandwich button collapses it to an icon rail */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-[var(--sea-200)]/10 bg-[var(--sea-900)] transition-[width] duration-200 ease-in-out lg:flex",
          collapsed ? "w-16" : "w-60",
        )}
      >
        {brand(collapsed)}
        {nav(collapsed)}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Admin navigation">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
            aria-hidden={true}
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-[var(--sea-200)]/10 bg-[var(--sea-900)] shadow-lg">
            <div className="flex items-center justify-between">
              {brand(false)}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="mr-3 rounded-md p-2 text-[var(--sea-200)]/80 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sea-200)]/70"
              >
                <X className="h-5 w-5" aria-hidden={true} />
              </button>
            </div>
            {nav(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header — greeting lives here per spec §1; Pulse repeats it
            with the last-login + refresh row (spec §4.4). */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-card/80 px-4 backdrop-blur">
          {/* One sandwich button for every viewport: on desktop it
              collapses/expands the sidebar to an icon rail, below lg
              it opens the drawer (the sidebar is hidden there). */}
          <button
            type="button"
            onClick={() => {
              if (window.matchMedia("(min-width: 1024px)").matches) {
                toggleCollapsed();
              } else {
                setOpen(true);
              }
            }}
            aria-label="Toggle navigation"
            className="rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Menu className="h-5 w-5" aria-hidden={true} />
          </button>
          <h1 className="truncate text-sm font-semibold text-foreground">
            Hello, {ownerName}
          </h1>
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
