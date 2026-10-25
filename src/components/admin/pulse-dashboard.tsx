"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Contact,
  Megaphone,
  RefreshCw,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import type { PulseBundle } from "@/lib/admin/metrics";
import {
  ADMIN_ROOT,
  ACTIVE_WINDOW_DAYS,
} from "@/lib/admin/constants";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import { Button } from "@/components/ui/button";
import { NewUsersChart } from "./new-users-chart";
import {
  FloatingCardGrid,
  PulseMetricCard,
  PulseMetricError,
  PulseMetricSkeleton,
} from "./pulse-metric-card";
import { SubscriptionBadge, formatLastLogin, formatRegistered } from "./admin-format";

/**
 * Pulse — the dashboard page body. Fetches the guarded server bundle
 * (/api/ashwini-control/pulse, everything computed in SQL), renders
 * the six metric cards / chart / fresh-users table / header row with
 * the last-login indicator and Refresh.
 */
export function PulseDashboard({ ownerName }: { ownerName: string }) {
  const [data, setData] = useState<PulseBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api${ADMIN_ROOT}/pulse`, { cache: "no-store" });
      if (!res.ok) throw new Error(`pulse ${res.status}`);
      setData((await res.json()) as PulseBundle);
    } catch (err) {
      console.error("[pulse] load failed:", err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cards = data
    ? [
        {
          key: "total",
          label: "Total Users",
          value: data.totalUsers,
          icon: Users,
          accent: "sea" as const,
          definition: "All registered customers. Invited teammates and the owner account are not counted.",
        },
        {
          key: "active",
          label: "Active Users",
          value: data.activeUsers,
          icon: Activity,
          accent: "deep" as const,
          definition: `Customers with a sign-in or recorded activity in the last ${ACTIVE_WINDOW_DAYS} days.`,
        },
        {
          key: "campaigns",
          label: "Total Campaigns",
          value: data.totalCampaigns,
          icon: Megaphone,
          accent: "mid" as const,
          definition: "All campaigns (broadcasts) across all accounts.",
        },
        {
          key: "contacts",
          label: "Contacts",
          value: data.contacts,
          icon: Contact,
          accent: "foam" as const,
          definition: "All non-deleted contacts across all accounts.",
        },
        {
          key: "free",
          label: "Free Users",
          value: data.freeUsers,
          icon: UserMinus,
          accent: "slate" as const,
          definition:
            "Total Users minus Subscribers — trial, expired trial, free plan, canceled, or no subscription. Free + Subscribers = Total.",
        },
        {
          key: "subs",
          label: "Subscribers",
          value: data.subscribers,
          icon: UserPlus,
          accent: "steel" as const,
          definition:
            "Customers whose subscription is EFFECTIVELY active right now (shared effective-status function, plan price greater than 0).",
        },
      ]
    : [];

  return (
    <div className="space-y-5">
      {/* Header row (spec §4.4) */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Hello, {ownerName}</h2>
          {/* div, not p: the loading branch renders <Skeleton>, a <div>,
              which HTML forbids inside <p> (hydration error). */}
          <div className="mt-1 text-sm text-muted-foreground">
            {data ? (
              <>Last login: {formatLastLogin(data.lastLoginAt)}</>
            ) : loading ? (
              <Skeleton className="h-4 w-40" />
            ) : (
              <>Last login: —</>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden={true} />
          Refresh
        </Button>
      </div>

      {/* Six cards, 3×2 desktop / 2×3 tablet / 1 col mobile —
          floating-card-gallery motion (tilt + stagger + hover lift) */}
      <FloatingCardGrid>
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <PulseMetricSkeleton key={i} index={i} />)
          : error
            ? Array.from({ length: 6 }).map((_, i) => (
                <PulseMetricError key={i} index={i} onRetry={() => void load()} />
              ))
            : cards.map((c, i) => (
                <PulseMetricCard
                  key={c.key}
                  index={i}
                  label={c.label}
                  value={c.value}
                  icon={c.icon}
                  accent={c.accent}
                  definition={c.definition}
                />
              ))}
      </FloatingCardGrid>

      {/* Chart */}
      {loading ? (
        <Skeleton className="h-80 w-full rounded-xl" />
      ) : error ? (
        <PulseMetricError onRetry={() => void load()} />
      ) : data ? (
        <NewUsersChart months={data.months} />
      ) : null}

      {/* User Registrations */}
      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">User Registrations</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The {data?.freshUsers.length ?? 10} most recent registrations, newest first
            </p>
          </div>
          <Link
            href={`${ADMIN_ROOT}/member-ledger`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          >
            View all
          </Link>
        </header>

        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="p-5">
            <PulseMetricError onRetry={() => void load()} />
          </div>
        ) : !data || data.freshUsers.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title="No registrations yet"
              hint="New customers show up here the moment they register."
              icon={UserPlus}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Most recent customer registrations</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                  <th scope="col" className="px-5 py-2.5">User</th>
                  <th scope="col" className="px-5 py-2.5">Registered</th>
                  <th scope="col" className="px-5 py-2.5">Subscription</th>
                </tr>
              </thead>
              <tbody>
                {data.freshUsers.map((u) => (
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
        )}
      </section>

      {/* Billing-schema honesty note (spec §3/§6): the Monthly/Yearly
          affordances render regardless; this line tells the owner why
          the numbers are zero while the tables don't exist. */}
      {data && !data.subscriptionsAvailable && (
        <p className="text-xs text-muted-foreground">
          Subscriptions show zero: this schema has no plans/subscriptions tables yet. The
          Monthly / Yearly pipeline is live in code and will populate the day they exist.
        </p>
      )}
    </div>
  );
}
