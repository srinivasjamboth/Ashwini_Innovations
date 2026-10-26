"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Eye, EyeOff, Loader2, RefreshCw, UserPlus } from "lucide-react";
import { ADMIN_ROOT } from "@/lib/admin/constants";
import { PHONE_COUNTRIES } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * Add New User — a right-side slide-over (the SAME Sheet the subscription
 * panel uses; never a centered modal, spec Part 4). It collects exactly
 * the fields the customer-facing signup collects — Full name, Email,
 * Mobile (dial-code + number) and Password — and creates the customer
 * through the auth admin API so the existing signup triggers build the
 * account, phone and 7-day trial. The customer-side app is not modified;
 * only the shared phone validator and the dial-code list are reused.
 *
 * The admin always sets the password (no invite/email flow). "Generate
 * strong password" fills a random one that satisfies the admin rule; the
 * chosen value is revealed once after creation, with a copy button and a
 * "this is the only time it will be shown" note.
 */

interface CreatedInfo {
  fullName: string;
  email: string;
  password: string;
}

const inputClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const labelClass = "text-xs font-medium text-muted-foreground";

/** Crypto-random password that always meets the admin rule (letter +
 *  digit, ≥8). Reads the webcrypto CSPRNG, not Math.random. */
function generateStrongPassword(length = 16): string {
  const sets = [
    "abcdefghijkmnopqrstuvwxyz", // lower
    "ABCDEFGHJKLMNPQRSTUVWXYZ", // upper
    "23456789", // digits
    "!@#$%^&*", // symbols
  ];
  const all = sets.join("");
  const rand = new Uint32Array(length);
  crypto.getRandomValues(rand);
  const chars = Array.from({ length }, (_, i) => all[rand[i] % all.length]);
  // Guarantee at least one character from each required class at random
  // positions, each drawn from fresh entropy.
  const force = new Uint32Array(sets.length * 2);
  crypto.getRandomValues(force);
  sets.forEach((set, k) => {
    const idx = force[k] % length;
    chars[idx] = set[force[sets.length + k] % set.length];
  });
  return chars.join("");
}

export function AddUserPanel({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a successful create so the ledger can refresh. */
  onCreated: () => void;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneCode, setPhoneCode] = useState(PHONE_COUNTRIES[0].code);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInfo | null>(null);
  const [copied, setCopied] = useState(false);

  const fullPhone = `${phoneCode}${phone}`;

  // Reset the "created" confirmation when the panel is (re)opened.
  useEffect(() => {
    if (open) {
      setCreated(null);
      setCopied(false);
      setFormError(null);
      setFieldErrors({});
    }
  }, [open]);

  const resetForm = () => {
    setFullName("");
    setEmail("");
    setPhoneCode(PHONE_COUNTRIES[0].code);
    setPhone("");
    setPassword("");
    setShowPassword(false);
    setFieldErrors({});
    setFormError(null);
    setCopied(false);
  };

  const canSubmit = useMemo(
    () => Boolean(fullName.trim() && email.trim() && phone.trim() && password) && !saving,
    [fullName, email, phone, password, saving],
  );

  async function submit() {
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api${ADMIN_ROOT}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ fullName, email, phone: fullPhone, password }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        fieldErrors?: Record<string, string>;
        ok?: boolean;
        fullName?: string;
        email?: string;
        password?: string;
      };

      if (res.status === 409 || json.error === "email_taken") {
        setFieldErrors({ email: "A customer with this email already exists." });
        return;
      }
      if (json.error === "validation" && json.fieldErrors) {
        setFieldErrors(json.fieldErrors);
        return;
      }
      if (!res.ok || !json.ok) {
        setFormError("Couldn’t create the user. Please try again.");
        return;
      }

      // Success — show the password once and refresh the ledger so the
      // new customer appears at the top and Pulse counts update.
      setCreated({ fullName: json.fullName!, email: json.email!, password: json.password! });
      onCreated();
    } catch {
      setFormError("Couldn’t reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(created?.password ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the value is still visible for manual copy */
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v && !saving) onClose(); }}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-[var(--sea-200)] bg-[var(--sea-50)]">
          <SheetTitle className="flex items-center gap-2 text-[var(--sea-800)]">
            <UserPlus className="h-4 w-4" aria-hidden={true} />
            {created ? "Customer created" : "Add new user"}
          </SheetTitle>
          <SheetDescription className="text-[var(--sea-700)]">
            {created
              ? "Share these credentials with the customer securely."
              : "Creates the account, phone and 7-day trial exactly like self-serve signup."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {created ? (
            <div className="space-y-4">
              <div
                role="status"
                aria-live="polite"
                className="rounded-lg border border-[var(--sea-200)] bg-[var(--sea-50)] p-4 text-sm"
              >
                <p className="font-medium text-[var(--sea-800)]">{created.fullName}</p>
                <p className="text-muted-foreground">{created.email}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Customer created — share these credentials securely.
                </p>
              </div>

              <div>
                <label className={labelClass} htmlFor="newuser-copied-pw">
                  Password
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <code
                    id="newuser-copied-pw"
                    className="flex-1 break-all rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-sm"
                  >
                    {created.password}
                  </code>
                  <Button size="sm" variant="outline" onClick={copyPassword} className="shrink-0">
                    {copied ? <Check className="h-4 w-4" aria-hidden={true} /> : null}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  This is the only time the password will be shown. Store it safely before closing.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    resetForm();
                    setCreated(null);
                  }}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden={true} />
                  Add another
                </Button>
                <Button
                  onClick={onClose}
                  className="bg-[var(--sea-800)] text-white hover:bg-[var(--sea-700)]"
                >
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {formError && (
                <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                  {formError}
                </p>
              )}

              <div>
                <label className={labelClass} htmlFor="newuser-name">
                  Full name <span className="text-red-500">*</span>
                </label>
                <input
                  id="newuser-name"
                  className={inputClass + " mt-1"}
                  value={fullName}
                  maxLength={120}
                  autoComplete="off"
                  aria-invalid={fieldErrors.fullName ? true : undefined}
                  onChange={(e) => setFullName(e.target.value)}
                  disabled={saving}
                />
                {fieldErrors.fullName && <FieldError>{fieldErrors.fullName}</FieldError>}
              </div>

              <div>
                <label className={labelClass} htmlFor="newuser-email">
                  Email <span className="text-red-500">*</span>
                </label>
                <input
                  id="newuser-email"
                  type="email"
                  className={inputClass + " mt-1"}
                  value={email}
                  autoComplete="off"
                  aria-invalid={fieldErrors.email ? true : undefined}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={saving}
                />
                {fieldErrors.email && <FieldError>{fieldErrors.email}</FieldError>}
              </div>

              <div>
                <label className={labelClass} htmlFor="newuser-phone">
                  Mobile <span className="text-red-500">*</span>
                </label>
                <div className="mt-1 flex gap-2">
                  <select
                    aria-label="Country dialling code"
                    className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring"
                    value={phoneCode}
                    onChange={(e) => setPhoneCode(e.target.value)}
                    disabled={saving}
                  >
                    {PHONE_COUNTRIES.map((c) => (
                      <option key={c.iso + c.code} value={c.code}>
                        {c.iso} {c.code}
                      </option>
                    ))}
                  </select>
                  <input
                    id="newuser-phone"
                    inputMode="tel"
                    className={inputClass}
                    value={phone}
                    autoComplete="off"
                    aria-invalid={fieldErrors.phone ? true : undefined}
                    onChange={(e) => setPhone(e.target.value.replace(/[^\d\s-]/g, ""))}
                    disabled={saving}
                  />
                </div>
                {fieldErrors.phone && <FieldError>{fieldErrors.phone}</FieldError>}
              </div>

              <div>
                <label className={labelClass} htmlFor="newuser-password">
                  Password <span className="text-red-500">*</span>
                </label>
                <div className="mt-1 flex gap-2">
                  <div className="relative flex-1">
                    <input
                      id="newuser-password"
                      type={showPassword ? "text" : "password"}
                      className={inputClass + " pr-9"}
                      value={password}
                      autoComplete="new-password"
                      aria-invalid={fieldErrors.password ? true : undefined}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={saving}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-pressed={showPassword}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" aria-hidden={true} /> : <Eye className="h-4 w-4" aria-hidden={true} />}
                    </button>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setPassword(generateStrongPassword());
                      setShowPassword(true);
                    }}
                    disabled={saving}
                  >
                    Generate
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">At least 8 characters, with a letter and a number.</p>
                {fieldErrors.password && <FieldError>{fieldErrors.password}</FieldError>}
              </div>
            </form>
          )}
        </div>

        {!created && (
          <SheetFooter className="border-t border-[var(--sea-200)] bg-[var(--sea-50)]">
            <div className="flex w-full items-center justify-end gap-2">
              <Button variant="outline" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="bg-[var(--sea-800)] text-white hover:bg-[var(--sea-700)]"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden={true} />}
                {saving ? "Creating…" : "Create user"}
              </Button>
            </div>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{children}</p>;
}
