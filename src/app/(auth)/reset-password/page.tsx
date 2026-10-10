"use client";

// ============================================================
// /reset-password — the form the password-reset email leads to.
//
// The emailed link lands on /auth/callback, which exchanges it for a
// session and 303s here. So on arrival the visitor either has a
// recovery session (show the form) or doesn't (the link was spent,
// expired, or opened in a browser without the PKCE verifier cookie —
// say so, with a way to request a new one). Bouncing to /login with
// no explanation was the locked-out experience issue #592 describes.
//
// Not gated by the middleware on purpose: the "expired" state must be
// reachable signed-out, and a signed-in visitor must not be redirected
// away from the very page they need.
// ============================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import {
  CheckCircle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  MailX,
} from "lucide-react";
import {
  AuthAlert,
  AuthField,
  AuthShell,
} from "@/components/auth/auth-shell";

type Status = "checking" | "ready" | "expired" | "done";

export default function ResetPasswordPage() {
  const t = useTranslations("ResetPasswordPage");
  const supabase = createClient();

  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // The callback wrote the session cookies server-side; the browser
    // client reads them here. No user → the link didn't yield a session.
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!cancelled) setStatus(user ? "ready" : "expired");
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("passwordsMismatch"));
      return;
    }
    // Same floor as /signup.
    if (password.length < 6) {
      setError(t("passwordTooShort"));
      return;
    }

    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSaving(false);

    if (error) {
      setError(error.message);
      return;
    }
    setStatus("done");
  };

  if (status === "checking") {
    return (
      <AuthShell mode="reset">
        <p className="auth-loading">
          <Loader2 className="auth-spin" aria-hidden={true} />
          {t("checking")}
        </p>
        {/* An escape hatch, not a second call to action. The check is a
            client round-trip, and a visitor whose session never arrives
            would otherwise stare at a spinner with no way out. */}
        <p className="auth-switch">
          <Link href="/login" className="auth-link">
            {t("backToSignIn")}
          </Link>
        </p>
      </AuthShell>
    );
  }

  if (status === "expired") {
    return (
      <AuthShell mode="reset">
        <div className="auth-success">
          <span className="auth-success-icon">
            <MailX aria-hidden={true} />
          </span>
          <h1 className="auth-title">{t("expiredTitle")}</h1>
          <p className="auth-subtitle">{t("expiredDesc")}</p>
        </div>
        <Link href="/forgot-password" className="auth-submit">
          {t("requestNewLink")}
        </Link>
        <Link href="/login" className="auth-submit-secondary">
          {t("backToSignIn")}
        </Link>
      </AuthShell>
    );
  }

  if (status === "done") {
    return (
      <AuthShell mode="reset">
        <div className="auth-success">
          <span className="auth-success-icon">
            <CheckCircle aria-hidden={true} />
          </span>
          <h1 className="auth-title">{t("successTitle")}</h1>
          <p className="auth-subtitle">{t("successDesc")}</p>
        </div>
        <button
          type="button"
          className="auth-submit"
          onClick={() => {
            // Full-page navigation, like /login: the middleware
            // gating /dashboard must see the session cookies on a
            // fresh top-level request, which a soft router.push
            // can race (issue #365).
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full reload so the auth cookies reach the middleware
            window.location.href = "/dashboard";
          }}
        >
          {t("continueToDashboard")}
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell mode="reset">
      <h1 className="auth-title">{t("title")}</h1>
      <p className="auth-subtitle">{t("desc")}</p>

      <form onSubmit={handleSubmit}>
        {error && <AuthAlert>{error}</AuthAlert>}

        <AuthField
          icon={KeyRound}
          type={showPassword ? "text" : "password"}
          name="password"
          autoComplete="new-password"
          label={t("passwordLabel")}
          placeholder={t("passwordPlaceholder")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          disabled={saving}
          trailing={
            /* One eye for both fields — see /signup. */
            <button
              type="button"
              className="auth-trailing-btn"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-label={showPassword ? t("hidePassword") : t("showPassword")}
            >
              {showPassword ? (
                <EyeOff aria-hidden={true} />
              ) : (
                <Eye aria-hidden={true} />
              )}
            </button>
          }
        />

        <AuthField
          icon={Lock}
          type={showPassword ? "text" : "password"}
          name="confirmPassword"
          autoComplete="new-password"
          label={t("confirmPasswordLabel")}
          placeholder={t("confirmPasswordPlaceholder")}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          disabled={saving}
        />

        <button type="submit" className="auth-submit" disabled={saving}>
          {saving && <Loader2 className="auth-spin" aria-hidden={true} />}
          {saving ? t("saving") : t("submit")}
        </button>
      </form>
    </AuthShell>
  );
}
