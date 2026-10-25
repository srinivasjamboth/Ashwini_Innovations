"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ADMIN_ROOT, ADMIN_TIMEZONE } from "@/lib/admin/constants";
import type { VaultPlanOption, VaultRowDto, VaultStatus } from "@/lib/admin/vault";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PaymentStateLine, VaultStatusBadge, formatDay, formatInr } from "./admin-format";

/**
 * Subscription Update slide-over — the ONLY write in the admin area
 * (spec Part 4). Reuses the existing Sheet side panel (no centered
 * modal). Two steps: edit → before/after review → save. The save is a
 * PATCH carrying the row's updated_at as a concurrency token; a 409
 * reloads the latest values into the form instead of clobbering them.
 * Nothing here charges or refunds anyone — the gateway warning says so
 * out loud when a Razorpay reference exists (spec 4.4).
 */

type UpdateStatus = "active" | "cancelled" | "expired";

interface Props {
  subscription: VaultRowDto | null;
  plans: VaultPlanOption[];
  onClose: () => void;
  /** Refresh after a successful save (list refetch / router.refresh). */
  onUpdated: (row?: VaultRowDto) => void;
}
type PanelProps = Omit<Props, "subscription"> & { subscription: VaultRowDto };

/* ---------- IST calendar-day helpers (date inputs are plain days) --- */

function isoToIstDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ADMIN_TIMEZONE }).format(new Date(iso));
}
function todayIst(): string {
  return isoToIstDate(new Date().toISOString());
}
function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Month arithmetic clamps to the target month's last day
 *  (31 Jan + 1 month → 28/29 Feb, not some March overflow). */
function addMonthsIso(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, last);
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** Trial / past-due subscriptions open the panel as Active — the
 *  spec's status vocabulary is exactly Active | Cancelled | Expired. */
function initialStatus(s: VaultStatus): UpdateStatus {
  return s === "cancelled" || s === "expired" ? s : "active";
}

function statusLabel(s: VaultStatus | UpdateStatus): string {
  return s === "active"
    ? "Active"
    : s === "cancelled"
      ? "Cancelled"
      : s === "expired"
        ? "Expired"
        : s === "trial"
          ? "Trial"
          : s === "past_due"
            ? "Past due"
            : "Initiated";
}

/* ------------------------------ inner panel ------------------------ */

function PanelInner({ subscription, plans, onClose, onUpdated }: PanelProps) {
  // `base` is the row as we last saw it server-side — the 409 path
  // replaces it and refills the form, so the token can never go stale.
  const [base, setBase] = useState<VaultRowDto>(subscription);
  const [planId, setPlanId] = useState(subscription.planId);
  const [cycle, setCycle] = useState<"monthly" | "yearly">(
    subscription.billingCycle === "yearly" ? "yearly" : "monthly",
  );
  const [status, setStatus] = useState<UpdateStatus>(initialStatus(subscription.status));
  const [expiry, setExpiry] = useState<string>(() =>
    subscription.expiresOn ? isoToIstDate(subscription.expiresOn) : addDaysIso(todayIst(), 30),
  );
  const [amount, setAmount] = useState<string>(() => String(subscription.amount ?? 0));
  const [amountTouched, setAmountTouched] = useState(false);
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Amount defaults from the plan price for the chosen cycle where
  // defined (spec 4.2); a manual edit wins until the plan changes.
  useEffect(() => {
    const price = plans.find((p) => p.id === planId)?.prices[cycle];
    if (price != null && !amountTouched) setAmount(String(price));
  }, [planId, cycle, plans, amountTouched]);

  /* Quick-extend chips add to the CURRENT expiry, or to today when
   * the subscription has already lapsed (spec 4.2). */
  const extendBase = useMemo(() => {
    if (!base.expiresOn) return todayIst();
    const expiryDay = isoToIstDate(base.expiresOn);
    return expiryDay < todayIst() ? todayIst() : expiryDay;
  }, [base.expiresOn]);
  const chips = useMemo(
    () => [
      { label: "+30 days", value: addDaysIso(extendBase, 30) },
      { label: "+1 month", value: addMonthsIso(extendBase, 1) },
      { label: "+1 year", value: addMonthsIso(extendBase, 12) },
    ],
    [extendBase],
  );

  const setField = useCallback((patch: Record<string, string>) => {
    setFieldErrors((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  }, []);

  /* Client mirror of the server rules (spec 4.5) — the API re-checks
   * everything, this only makes errors appear before the round-trip. */
  const validateLocally = (): boolean => {
    const errors: Record<string, string> = {};
    if (!planId) errors.planId = "Choose a plan.";
    if (!expiry || Number.isNaN(Date.parse(`${expiry}T00:00:00Z`))) {
      errors.periodEnd = "Pick an expiry date.";
    } else if (status === "active" && expiry < todayIst()) {
      errors.periodEnd = "An Active subscription needs a future expiry date.";
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) errors.amount = "Amount must be 0 or more.";
    else if (Math.round(amt * 100) / 100 !== amt) errors.amount = "Amount allows two decimals.";
    if (reason.trim().length < 5) errors.reason = "A reason of at least 5 characters is required.";
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  /* Review step: before → after for every changed field (spec 4.3). */
  const changes = useMemo(() => {
    const list: { label: string; before: string; after: string }[] = [];
    const planName = plans.find((p) => p.id === planId)?.name ?? planId;
    if (planId !== base.planId || planName !== base.planName) {
      list.push({ label: "Plan", before: base.planName, after: planName });
    }
    if (cycle !== (base.billingCycle === "yearly" ? "yearly" : "monthly")) {
      list.push({
        label: "Billing",
        before: base.billingCycle === "yearly" ? "Yearly" : "Monthly",
        after: cycle === "yearly" ? "Yearly" : "Monthly",
      });
    }
    const beforeExpiry = base.expiresOn ? formatDay(base.expiresOn) : "—";
    const afterExpiry = expiry ? formatDay(`${expiry}T12:00:00Z`) : "—";
    if (beforeExpiry !== afterExpiry) list.push({ label: "Expiry", before: beforeExpiry, after: afterExpiry });
    if (status !== initialStatus(base.status) || status !== base.status) {
      list.push({ label: "Status", before: statusLabel(base.status), after: statusLabel(status) });
    }
    const amt = Number(amount) || 0;
    if (amt !== base.amount) list.push({ label: "Amount", before: formatInr(base.amount), after: formatInr(amt) });
    return list;
  }, [planId, cycle, status, expiry, amount, base, plans]);

  const reloadLatest = useCallback(async () => {
    // 409 path — pull the fresh row (GET detail returns the same DTO
    // shape) and refill every field so the next save carries the new
    // updated_at token instead of blindly overwriting the webhook.
    try {
      const res = await fetch(`/api${ADMIN_ROOT}/vault/${subscription.subscriptionId}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { subscription: VaultRowDto };
      const row = json.subscription;
      setBase(row);
      setPlanId(row.planId);
      setCycle(row.billingCycle === "yearly" ? "yearly" : "monthly");
      setStatus(initialStatus(row.status));
      setExpiry(row.expiresOn ? isoToIstDate(row.expiresOn) : addDaysIso(todayIst(), 30));
      setAmount(String(row.amount ?? 0));
      setAmountTouched(false);
      setStep("edit");
      setFieldErrors({});
      setFormError(null);
    } catch {
      /* the toast below still tells the admin the save was rejected */
    }
  }, [subscription.subscriptionId]);

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch(`/api${ADMIN_ROOT}/vault/${base.subscriptionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId,
          billingCycle: cycle,
          status,
          periodEnd: expiry,
          amount: Number(amount),
          reason: reason.trim(),
          expectedUpdatedAt: base.updatedAt,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        row?: VaultRowDto;
        fieldErrors?: Record<string, string>;
        error?: string;
        hint?: string;
      };
      if (res.ok) {
        toast.success(`Subscription for ${base.customer.name} updated`);
        onUpdated(json.row);
        onClose();
        return
      }
      if (res.status === 400 && json.fieldErrors) {
        setFieldErrors(json.fieldErrors);
        setFormError(json.fieldErrors.form ?? null);
        setStep("edit");
        return;
      }
      if (res.status === 409) {
        toast.info("This record changed since you opened it. The latest values are now loaded — please review and save again.");
        setStep("edit");
        await reloadLatest();
        return;
      }
      if (res.status === 503 && json.error === "migrations_missing") {
        setFormError("Updates can't be saved yet — billing migrations 048 and 049 haven't been applied to the database.");
        return;
      }
      setFormError("Couldn't save the change. Please try again.");
    } catch {
      setFormError("Couldn't reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const fieldClass =
    "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

  return (
    <Sheet open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-[var(--sea-200)] bg-[var(--sea-50)]">
          <SheetTitle className="text-[var(--sea-800)]">
            {step === "review" ? "Review changes" : "Update subscription"}
          </SheetTitle>
          <SheetDescription>
            {base.customer.name} · {base.customer.email}
          </SheetDescription>
          {/* 4.1 — customer's current plan and status, live values */}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Current:</span>
            <span className="rounded-full border border-[var(--sea-200)] bg-[var(--sea-50)] px-2 py-0.5 text-xs font-medium text-[var(--sea-800)]">
              {base.planName}
            </span>
            <VaultStatusBadge status={base.status} />
            <PaymentStateLine state={base.paymentState} />
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {/* 4.4 — gateway warning, spec wording verbatim */}
          {base.gatewayLinked && (
            <div className="flex items-start gap-2.5 rounded-lg border border-[var(--sea-200)] bg-[var(--sea-100)] px-3 py-2.5 text-xs text-[var(--sea-800)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden={true} />
              <p>
                This customer pays through the payment gateway. Changing the plan here updates
                Ashwini records only and does not change their gateway billing. No charge or
                refund is made by this action.
              </p>
            </div>
          )}

          {step === "edit" ? (
            <>
              <div className="space-y-1.5">
                <label htmlFor="vault-upd-plan" className="text-sm font-medium">Plan</label>
                <select
                  id="vault-upd-plan"
                  value={planId}
                  onChange={(e) => { setPlanId(e.target.value); setAmountTouched(false); setField({ planId: "" }); }}
                  className={fieldClass}
                >
                  {/* The current plan stays listed even if it was made
                      private since — the row must never lose its value */}
                  {!plans.some((p) => p.id === base.planId) && (
                    <option value={base.planId}>{base.planName}</option>
                  )}
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {plans.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No public plans found — the plans table feeds this list.
                  </p>
                )}
                {fieldErrors.planId && <p className="text-xs text-red-600">{fieldErrors.planId}</p>}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="vault-upd-cycle" className="text-sm font-medium">Billing cycle</label>
                <select
                  id="vault-upd-cycle"
                  value={cycle}
                  onChange={(e) => setCycle(e.target.value === "yearly" ? "yearly" : "monthly")}
                  className={fieldClass}
                >
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
                {fieldErrors.billingCycle && <p className="text-xs text-red-600">{fieldErrors.billingCycle}</p>}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="vault-upd-expiry" className="text-sm font-medium">Expiry date</label>
                <input
                  id="vault-upd-expiry"
                  type="date"
                  value={expiry}
                  onChange={(e) => { setExpiry(e.target.value); setField({ periodEnd: "" }); }}
                  className={fieldClass}
                />
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {chips.map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      onClick={() => { setExpiry(c.value); setField({ periodEnd: "" }); }}
                      className="rounded-full border border-[var(--sea-200)] bg-[var(--sea-50)] px-2.5 py-1 text-xs font-medium text-[var(--sea-800)] transition-colors hover:bg-[var(--sea-100)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Adds to the current expiry ({formatDay(`${extendBase}T12:00:00Z`)})
                  {base.expiresOn && isoToIstDate(base.expiresOn) < todayIst() ? " — already lapsed, counting from today" : ""}.
                </p>
                {fieldErrors.periodEnd && <p className="text-xs text-red-600">{fieldErrors.periodEnd}</p>}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="vault-upd-status" className="text-sm font-medium">Status</label>
                <select
                  id="vault-upd-status"
                  value={status}
                  onChange={(e) => { setStatus(e.target.value as UpdateStatus); setField({ status: "" }); }}
                  className={fieldClass}
                >
                  <option value="active">Active</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="expired">Expired</option>
                </select>
                {status === "active" && (
                  <p className="text-xs text-muted-foreground">Active needs an expiry date in the future.</p>
                )}
                {fieldErrors.status && <p className="text-xs text-red-600">{fieldErrors.status}</p>}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="vault-upd-amount" className="text-sm font-medium">Amount charged (INR)</label>
                <input
                  id="vault-upd-amount"
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setAmountTouched(true); setField({ amount: "" }); }}
                  className={fieldClass + " tabular-nums"}
                />
                <p className="text-xs text-muted-foreground">0 marks a complimentary subscription.</p>
                {fieldErrors.amount && <p className="text-xs text-red-600">{fieldErrors.amount}</p>}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="vault-upd-reason" className="text-sm font-medium">
                  Reason <span className="text-red-600">*</span>
                </label>
                <textarea
                  id="vault-upd-reason"
                  value={reason}
                  rows={3}
                  maxLength={500}
                  onChange={(e) => { setReason(e.target.value); setField({ reason: "" }); }}
                  placeholder="Why is this change being made? Stored in the audit log."
                  className="w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
                {fieldErrors.reason && <p className="text-xs text-red-600">{fieldErrors.reason}</p>}
              </div>

              {formError && (
                <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-red-600">
                  {formError}
                </p>
              )}
            </>
          ) : (
            /* ---- 4.3 Review: before → after, confirm before saving ---- */
            <div className="space-y-4">
              {changes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing has changed yet — the save would only record the reason. Go back and
                  adjust a field, or close the panel.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--sea-200)] rounded-lg border border-[var(--sea-200)]">
                  {changes.map((c) => (
                    <li key={c.label} className="grid grid-cols-[5rem_1fr_1fr] items-center gap-2 px-3 py-2.5 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">{c.label}</span>
                      <span className="text-muted-foreground line-through decoration-[var(--sea-200)]">{c.before}</span>
                      <span className="font-medium text-[var(--sea-800)]">{c.after}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="rounded-lg bg-[var(--sea-50)] px-3 py-2.5 text-sm">
                <p className="text-xs font-medium text-muted-foreground">Reason</p>
                <p className="mt-0.5 text-foreground">{reason.trim() || "—"}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                Saving updates the subscription, writes one history row and one audit row in a
                single transaction, and applies the new limits for the customer immediately.
              </p>
              {formError && (
                <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-red-600">
                  {formError}
                </p>
              )}
            </div>
          )}
        </div>

        <SheetFooter className="border-t border-[var(--sea-200)] flex-row">
          {step === "edit" ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={saving} className="flex-1">
                Cancel
              </Button>
              <Button
                onClick={() => { if (validateLocally()) setStep("review"); }}
                disabled={saving || plans.length === 0}
                className="flex-1 bg-[var(--sea-800)] text-white hover:bg-[var(--sea-700)]"
              >
                Review changes
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("edit")} disabled={saving} className="flex-1">
                <ArrowLeft className="h-4 w-4" aria-hidden={true} />
                Back
              </Button>
              <Button
                onClick={() => void save()}
                disabled={saving || reason.trim().length < 5}
                className="flex-1 bg-[var(--sea-800)] text-white hover:bg-[var(--sea-700)]"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden={true} />}
                Confirm and save
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function SubscriptionUpdatePanel({ subscription, plans, onClose, onUpdated }: Props) {
  if (!subscription) return null;
  // key = row id: opening a different row always rebuilds the form.
  return (
    <PanelInner
      key={`${subscription.subscriptionId}:${subscription.updatedAt}`}
      subscription={subscription}
      plans={plans}
      onClose={onClose}
      onUpdated={onUpdated}
    />
  );
}
