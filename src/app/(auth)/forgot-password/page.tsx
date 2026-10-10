"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { CheckCircle, Loader2, Mail } from "lucide-react";
import {
  AuthAlert,
  AuthField,
  AuthShell,
} from "@/components/auth/auth-shell";

export default function ForgotPasswordPage() {
  const t = useTranslations("ForgotPasswordPage");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // The emailed link returns to /auth/callback, which exchanges it
    // for a recovery session and forwards to /reset-password (issue
    // #592). Supabase must allow this origin under Authentication →
    // URL Configuration → Redirect URLs, or it silently falls back to
    // its Site URL; see docs/auth-emails.md.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <AuthShell mode="recover">
        <div className="auth-success">
          <span className="auth-success-icon">
            <CheckCircle aria-hidden={true} />
          </span>
          <h1 className="auth-title">{t("checkEmailTitle")}</h1>
          <p className="auth-subtitle">
            {t.rich("checkEmailDesc", {
              email,
              strong: (chunks) => <span className="auth-strong">{chunks}</span>,
            })}
          </p>
        </div>
        <Link href="/login" className="auth-submit-secondary">
          {t("backToSignIn")}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell mode="recover">
      <h1 className="auth-title">{t("title")}</h1>
      <p className="auth-subtitle">{t("desc")}</p>

      <form onSubmit={handleReset}>
        {error && <AuthAlert>{error}</AuthAlert>}

        <AuthField
          icon={Mail}
          type="email"
          name="email"
          autoComplete="email"
          label={t("emailLabel")}
          placeholder={t("emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={loading}
        />

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading && <Loader2 className="auth-spin" aria-hidden={true} />}
          {loading ? t("sending") : t("sendLink")}
        </button>
      </form>

      <p className="auth-switch">
        <Link href="/login" className="auth-link">
          {t("backToSignIn")}
        </Link>
      </p>
    </AuthShell>
  );
}
