"use client";

import { useState } from "react";
import { Eye, EyeOff, Loader2, Lock, Mail, ShieldCheck } from "lucide-react";
import { AuthAlert, AuthField, AuthShell } from "@/components/auth/auth-shell";

/**
 * The owner's sign-in form. Two fields, one button — deliberately
 * sparse (spec §2.1): no signup, no recovery link, no social login.
 *
 * The look is the client login's: same AuthShell sliding-panel frame,
 * same labelled icon fields and submit styling, so the owner's page and
 * the customer's page never drift. Only the copy is admin-specific.
 *
 * Every failure — wrong password, unknown email, valid *client*
 * credentials, locked out — renders the exact same generic message
 * returned by the API; the client never learns (or guesses) why.
 */
export function AdminLoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/ashwini-control/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; redirect?: string }
        | null;

      if (res.ok) {
        // Full navigation so the middleware sees the just-written
        // cookies on a top-level request (same reasoning as the
        // client /login page, issue #365).
        window.location.href = data?.redirect || "/ashwini-control";
        return;
      }
      // The API always answers with the generic string; keep it as
      // the single source so the two paths can't drift.
      setError(data?.error || "Invalid credentials");
      setLoading(false);
    } catch {
      setError("Invalid credentials");
      setLoading(false);
    }
  };

  return (
    <AuthShell mode="sign-in">
      <h1 className="auth-title">Platform Owner sign-in</h1>
      <p className="auth-subtitle">
        Restricted area. Access attempts are monitored.
      </p>

      <form onSubmit={handleSubmit}>
        {error && <AuthAlert>{error}</AuthAlert>}

        <AuthField
          icon={Mail}
          type="email"
          name="email"
          autoComplete="username"
          label="Email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={loading}
        />

        <AuthField
          icon={Lock}
          type={showPassword ? "text" : "password"}
          name="password"
          autoComplete="current-password"
          label="Password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={loading}
          trailing={
            <button
              type="button"
              className="auth-trailing-btn"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? (
                <EyeOff aria-hidden={true} />
              ) : (
                <Eye aria-hidden={true} />
              )}
            </button>
          }
        />

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading && <Loader2 className="auth-spin" aria-hidden={true} />}
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="auth-switch">
        <span className="inline-flex items-center justify-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden={true} />
          Authorized owner access only.
        </span>
      </p>
    </AuthShell>
  );
}
