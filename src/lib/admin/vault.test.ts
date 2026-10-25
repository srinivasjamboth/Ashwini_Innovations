import { describe, expect, it } from "vitest";
import {
  computeVaultStatus,
  dayEndExclusiveUtcMs,
  dayStartUtcMs,
  formatInr,
  isMissingSchema,
  parseVaultQuery,
  resolveRangeMs,
  resolveRowAmount,
  tzOffsetMs,
  validateVaultUpdate,
} from "./vault";

/**
 * Plan Vault unit tests (spec Part 8, pure-logic half). The live-SQL
 * comparisons need a database with migrations 048/049 applied and are
 * reported separately; everything here runs without one.
 */

const IST_OFFSET_MS = 19_800_000; // +05:30, no DST

/* ---------------- effective status (shared with Pulse/Ledger) ------ */

describe("computeVaultStatus", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const future = "2026-12-31T18:30:00.000Z";
  const past = "2026-09-01T18:30:00.000Z";

  it("shows a stored-active row with a future period end as active", () => {
    expect(computeVaultStatus({ status: "active", current_period_end: future, trial_end: null }, now)).toBe("active");
  });

  it("shows a stored-active row whose period already ended as expired (cron not run yet)", () => {
    expect(computeVaultStatus({ status: "active", current_period_end: past, trial_end: null }, now)).toBe("expired");
  });

  it("maps trialing with a live trial window to trial", () => {
    expect(computeVaultStatus({ status: "trialing", current_period_end: null, trial_end: future }, now)).toBe("trial");
  });

  it("maps an ended trial to expired", () => {
    expect(computeVaultStatus({ status: "trialing", current_period_end: null, trial_end: past }, now)).toBe("expired");
  });

  it("keeps past_due visible while the period is still live", () => {
    expect(computeVaultStatus({ status: "past_due", current_period_end: future, trial_end: null }, now)).toBe("past_due");
  });

  it("lets a hard period lapse beat past_due — expired is expired", () => {
    expect(computeVaultStatus({ status: "past_due", current_period_end: past, trial_end: null }, now)).toBe("expired");
  });

  it("distinguishes cancelled from expired", () => {
    expect(computeVaultStatus({ status: "canceled", current_period_end: future, trial_end: null }, now)).toBe("cancelled");
    expect(computeVaultStatus({ status: "expired", current_period_end: past, trial_end: null }, now)).toBe("expired");
  });

  it("fails closed for a missing row", () => {
    expect(computeVaultStatus(null)).toBe("expired");
  });
});

/* ---------------- IST day boundaries ------------------------------- */

describe("day boundaries (Asia/Kolkata)", () => {
  it("dayStartUtcMs is 00:00 IST inclusive", () => {
    expect(dayStartUtcMs("2026-10-10")).toBe(Date.UTC(2026, 9, 10) - IST_OFFSET_MS);
  });

  it("dayEndExclusiveUtcMs is exactly the next day's 00:00 IST", () => {
    expect(dayEndExclusiveUtcMs("2026-10-10")).toBe(Date.UTC(2026, 9, 11) - IST_OFFSET_MS);
    // A whole day spans exactly 24h in a DST-free timezone.
    expect(dayEndExclusiveUtcMs("2026-10-10")! - dayStartUtcMs("2026-10-10")!).toBe(86_400_000);
  });

  it("rejects malformed dates", () => {
    expect(dayStartUtcMs("10-10-2026")).toBeNull();
    expect(dayEndExclusiveUtcMs("2026/10/10")).toBeNull();
  });

  it("tzOffsetMs reports +05:30 for IST", () => {
    expect(tzOffsetMs(new Date("2026-10-10T00:00:00Z"), "Asia/Kolkata")).toBe(IST_OFFSET_MS);
  });

  it("resolveRangeMs keeps open ends open", () => {
    expect(resolveRangeMs(null, null)).toEqual({ startMs: null, endExclusiveMs: null });
    const r = resolveRangeMs("2026-10-01", "2026-10-10");
    expect(r.startMs).toBe(Date.UTC(2026, 9, 1) - IST_OFFSET_MS);
    expect(r.endExclusiveMs).toBe(Date.UTC(2026, 9, 11) - IST_OFFSET_MS);
  });
});

/* ---------------- URL query parsing -------------------------------- */

describe("parseVaultQuery", () => {
  it("defaults to newest-first page 1 at 25 rows", () => {
    const q = parseVaultQuery(new URLSearchParams());
    expect(q).toMatchObject({ q: "", page: 1, pageSize: 25, sortBy: "created", sortDir: "desc", dateField: "subscribed" });
  });

  it("rejects invalid values instead of trusting the URL", () => {
    const q = parseVaultQuery(
      new URLSearchParams("pageSize=999&page=-4&sort=drop&dateField=%27&status=active,bogus,,trial&billing=weekly"),
    );
    expect(q.pageSize).toBe(25);
    expect(q.page).toBe(1);
    expect(q.sortBy).toBe("created");
    expect(q.dateField).toBe("subscribed");
    expect(q.statuses).toEqual(["active", "trial"]);
    expect(q.billing).toBe("");
  });

  it("accepts the real vocabulary", () => {
    const q = parseVaultQuery(
      new URLSearchParams("pageSize=50&page=3&sort=amount&dir=asc&billing=yearly&dateField=registered&from=2026-01-01&to=2026-03-31&plan=pro,startup"),
    );
    expect(q).toMatchObject({ pageSize: 50, page: 3, sortBy: "amount", sortDir: "asc", billing: "yearly", dateField: "registered", from: "2026-01-01", to: "2026-03-31" });
    expect(q.plans).toEqual(["pro", "startup"]);
  });

  it("drops malformed from/to dates", () => {
    const q = parseVaultQuery(new URLSearchParams("from=2026-1-1&to=abc"));
    expect(q.from).toBeNull();
    expect(q.to).toBeNull();
  });
});

/* ---------------- update validation (mirrors the RPC) -------------- */

describe("validateVaultUpdate", () => {
  const futureIso = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const valid = {
    planId: "pro",
    billingCycle: "monthly",
    status: "active",
    periodEnd: futureIso,
    amount: 499,
    reason: "extended after bank receipt",
    expectedUpdatedAt: "2026-10-01T10:00:00.000Z",
  };

  it("accepts a complete update", () => {
    const r = validateVaultUpdate(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.periodEnd).toBe(new Date(futureIso).toISOString());
  });

  it("allows amount 0 (complimentary) and two decimals", () => {
    expect(validateVaultUpdate({ ...valid, amount: 0 }).ok).toBe(true);
    expect(validateVaultUpdate({ ...valid, amount: 499.5 }).ok).toBe(true);
  });

  it("rejects negative / over-precise amounts", () => {
    const neg = validateVaultUpdate({ ...valid, amount: -1 });
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.fieldErrors.amount).toBeDefined();
    const dp = validateVaultUpdate({ ...valid, amount: 499.999 });
    expect(dp.ok).toBe(false);
  });

  it("requires a future expiry for Active but not for Cancelled/Expired", () => {
    const pastIso = new Date(Date.now() - 86_400_000).toISOString();
    const bad = validateVaultUpdate({ ...valid, periodEnd: pastIso });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.fieldErrors.periodEnd).toMatch(/future/i);
    expect(validateVaultUpdate({ ...valid, status: "cancelled", periodEnd: pastIso }).ok).toBe(true);
    expect(validateVaultUpdate({ ...valid, status: "expired", periodEnd: pastIso }).ok).toBe(true);
  });

  it("requires reason ≥ 5 chars, a valid cycle, a plan and the token", () => {
    expect(validateVaultUpdate({ ...valid, reason: "ok" }).ok).toBe(false);
    expect(validateVaultUpdate({ ...valid, billingCycle: "weekly" }).ok).toBe(false);
    expect(validateVaultUpdate({ ...valid, planId: "  " }).ok).toBe(false);
    expect(validateVaultUpdate({ ...valid, expectedUpdatedAt: "" }).ok).toBe(false);
  });

  it("maps display statuses to the stored vocabulary", () => {
    const r = validateVaultUpdate({ ...valid, status: "cancelled" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe("cancelled"); // applyVaultUpdate maps to 'canceled'
  });

  it("survives a junk body", () => {
    expect(validateVaultUpdate(null).ok).toBe(false);
    expect(validateVaultUpdate("string").ok).toBe(false);
  });
});

/* ---------------- amount resolution + formatting ------------------- */

describe("resolveRowAmount", () => {
  it("prefers the latest paid transaction over the list price", () => {
    expect(resolveRowAmount(599, 499)).toBe(599);
  });
  it("falls back to the plan price, then to 0", () => {
    expect(resolveRowAmount(null, 499)).toBe(499);
    expect(resolveRowAmount(null, null)).toBe(0);
  });
});

describe("formatInr", () => {
  it("uses Indian digit grouping on rupees (schema stores rupees, not paise)", () => {
    expect(formatInr(1234567.5)).toContain("12,34,567.50");
    expect(formatInr(0)).toContain("0.00");
  });
});

describe("isMissingSchema", () => {
  it("recognises undefined-table PostgREST/PG errors", () => {
    expect(isMissingSchema({ code: "42P01" })).toBe(true);
    expect(isMissingSchema({ code: "PGRST205", message: "Could not find the table" })).toBe(true);
    expect(isMissingSchema({ code: "PGRST202" })).toBe(true);
    expect(isMissingSchema({ code: "22P02", message: "invalid input syntax" })).toBe(false);
    expect(isMissingSchema(null)).toBe(false);
  });
});
