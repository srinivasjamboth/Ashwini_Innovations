"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Users } from "lucide-react";
import type { MonthPoint } from "@/lib/admin/metrics";
import { EmptyState } from "@/components/dashboard/empty-state";
import { cn } from "@/lib/utils";

/**
 * "New users" per month — the Pulse chart, matched to the reference:
 * smooth monotone sea-blue line (~3px), solid circular markers on every
 * month, soft sea gradient fading to transparent underneath, light
 * horizontal grid lines only, integer y ticks from 0, "Mon YYYY"
 * x-labels, hover tooltip "Aug 2026: 20 new users", and a
 * New / Cumulative toggle. Months arrive zero-filled from the SQL
 * bucket (lib/admin/metrics → admin_new_users_by_month), so the
 * series always spans exactly the trailing CHART_MONTHS window.
 *
 * Recharts is the charting library the project already ships (the
 * vendored Tremor bar-chart draws on it).
 */

const LINE_SEA = "#0D3B54"; // sea-800 — the admin palette's chart color

interface ChartDatum {
  label: string;
  value: number;
}

function formatMonthLabel(monthStart: string): string {
  // monthStart is a plain ISO date (first of the month) — parse in UTC
  // so no local-timezone drift can move it into the previous month.
  const d = new Date(`${monthStart}T00:00:00Z`);
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

export function NewUsersChart({ months }: { months: MonthPoint[] }) {
  const [mode, setMode] = useState<"new" | "cumulative">("new");

  const data: ChartDatum[] = useMemo(
    () =>
      months.map((m) => ({
        label: formatMonthLabel(m.month_start),
        value: mode === "new" ? m.new_users : m.cumulative,
      })),
    [months, mode],
  );

  const total = months.reduce((sum, m) => sum + m.new_users, 0);
  if (months.length === 0 || total === 0) {
    return (
      <section className="flex h-full flex-col rounded-xl border border-border bg-card">
        <header className="flex items-center gap-2 border-b border-border px-5 py-4">
          <Users className="h-4 w-4 text-muted-foreground" aria-hidden={true} />
          <h2 className="text-sm font-semibold text-foreground">New users</h2>
        </header>
        <div className="flex-1 p-5">
          <EmptyState
            title="No registrations yet"
            hint="Monthly signup counts appear here as soon as the first customers register."
            icon={Users}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" aria-hidden={true} />
          <div>
            <h2 className="text-sm font-semibold text-foreground">New users</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Registrations per month, last 12 months ({mode === "new" ? "new" : "cumulative"})
            </p>
          </div>
        </div>
        <div
          role="group"
          aria-label="Chart mode"
          className="flex items-center gap-1 rounded-lg bg-muted/60 p-1"
        >
          {(["new", "cumulative"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                mode === m
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "new" ? "New" : "Cumulative"}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-64 flex-1 px-2 py-4" aria-hidden={false}>
        <p className="sr-only">
          {mode === "new"
            ? "Line chart of new customer registrations per month over the last 12 months."
            : "Line chart of cumulative customer registrations per month over the last 12 months."}
        </p>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="admin-new-users-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={LINE_SEA} stopOpacity={0.28} />
                <stop offset="100%" stopColor={LINE_SEA} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="4 4" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              minTickGap={16}
              tickMargin={8}
            />
            <YAxis
              allowDecimals={false}
              domain={[0, "auto"]}
              tickLine={false}
              axisLine={false}
              width={40}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            />
            <RechartsTooltip
              cursor={{ stroke: "var(--border)" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as ChartDatum;
                // In Cumulative mode the value is a running total, not the
                // month's new signups — label it so the tooltip can't mislead.
                const unit =
                  mode === "new"
                    ? `new user${p.value === 1 ? "" : "s"}`
                    : `total user${p.value === 1 ? "" : "s"}`;
                return (
                  <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                    {p.label}: {p.value.toLocaleString()} {unit}
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={LINE_SEA}
              strokeWidth={3}
              fill="url(#admin-new-users-fill)"
              dot={{ r: 4, fill: LINE_SEA, stroke: LINE_SEA, strokeWidth: 0 }}
              activeDot={{ r: 6, fill: LINE_SEA, stroke: "var(--card)", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
