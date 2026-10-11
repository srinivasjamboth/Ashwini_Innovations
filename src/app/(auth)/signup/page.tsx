"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { isValidPhone, phoneForDb } from "@/lib/auth/phone";
import { CheckCircle, Eye, EyeOff, Loader2, Lock, Mail, User } from "lucide-react";
import {
  AuthAlert,
  AuthConsent,
  AuthField,
  AuthPhoneField,
  AuthShell,
  PHONE_COUNTRIES,
} from "@/components/auth/auth-shell";

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip. `emailRedirectTo` below
  // sends the verified user to /join/<token> so they land on the
  // redeem step instead of being dropped on /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("SignupPage");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  // The number arrives in two pieces — the dialling-code select and the
  // national-number field — and is joined here, so the value the
  // validator and the database see is the same one the user saw.
  const [phoneCode, setPhoneCode] = useState(PHONE_COUNTRIES[0].code);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const fullPhone = `${phoneCode}${phone}`;

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!agreed) {
      setError(t("consentRequired"));
      return;
    }

    if (password !== confirmPassword) {
      setError(t("passwordsMismatch"));
      return;
    }

    if (password.length < 6) {
      setError(t("passwordTooShort"));
      return;
    }

    // Checked here rather than by the browser: the field accepts the
    // separators people actually type — spaces, dashes, brackets — and
    // `isValidPhone` is the same shape the `profiles.phone` CHECK
    // enforces after 044_profile_phone.sql normalises them away.
    const normalizedPhone = phoneForDb(fullPhone);
    if (!normalizedPhone || !isValidPhone(fullPhone)) {
      setError(t("phoneInvalid"));
      return;
    }

    setLoading(true);

    // Always name our own origin as the place the confirmation link
    // returns to. Previously this was left unset unless an invite was
    // involved, so Supabase fell back to its Site URL — which on a
    // freshly-created or self-hosted project is `http://localhost:3000`
    // (issue #595) — and even when the Site URL was right the link
    // landed on `/` with an unexchanged `?code=`, so the user had to
    // sign in again after verifying. /auth/callback exchanges the link
    // for a session and forwards to `next` (issue #592). Supabase still
    // has to allow this origin under Authentication → URL Configuration
    // → Redirect URLs.
    const next = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/dashboard";
    const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          // `handle_new_user` (migration 044) copies both of these onto
          // the profile row it creates for the new account.
          phone: normalizedPhone,
        },
        emailRedirectTo,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // With "Confirm email" disabled in Supabase, signUp returns an active
    // session — go straight to the app instead of showing the
    // check-your-email screen (which would only make the user log in again).
    if (data.session) {
      window.location.assign(next);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <AuthShell mode="sign-up">
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
        <Link
          href={
            inviteToken
              ? `/login?invite=${encodeURIComponent(inviteToken)}`
              : "/login"
          }
          className="auth-submit-secondary"
        >
          {t("backToSignIn")}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell mode="sign-up">
      <h1 className="auth-title">
        {inviteToken ? t("titleJoin") : t("title")}
      </h1>
      <p className="auth-subtitle">
        {inviteToken ? t("descJoin") : t("desc")}
      </p>

      <form onSubmit={handleSignup}>
        {error && <AuthAlert>{error}</AuthAlert>}

        <AuthField
          icon={User}
          type="text"
          name="full_name"
          autoComplete="name"
          label={t("fullNameLabel")}
          placeholder={t("fullNamePlaceholder")}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          maxLength={120}
          disabled={loading}
        />

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

        <AuthPhoneField
          label={t("phoneLabel")}
          placeholder={t("phonePlaceholder")}
          code={phoneCode}
          number={phone}
          onCodeChange={setPhoneCode}
          onNumberChange={setPhone}
          required
          disabled={loading}
        />
        <p className="auth-hint">{t("phoneHint")}</p>

        {/* The eye sits in the first field but governs both — it controls
            what you can see, so it would be odd for it to reveal one
            password and leave its confirmation masked. */}
        <AuthField
          icon={Lock}
          type={showPassword ? "text" : "password"}
          name="password"
          autoComplete="new-password"
          label={t("passwordLabel")}
          placeholder={t("passwordPlaceholder")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          disabled={loading}
          trailing={
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
          disabled={loading}
        />

        <AuthConsent checked={agreed} onChange={setAgreed} disabled={loading}>
          {t.rich("consent", {
            terms: (chunks) => (
              <Link href="/terms" className="auth-link">
                {chunks}
              </Link>
            ),
            privacy: (chunks) => (
              <Link href="/privacy" className="auth-link">
                {chunks}
              </Link>
            ),
          })}
        </AuthConsent>

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading && <Loader2 className="auth-spin" aria-hidden={true} />}
          {loading ? t("creating") : t("submit")}
        </button>
      </form>

      <p className="auth-switch">
        {t("haveAccount")}{" "}
        <Link
          href={
            inviteToken
              ? `/login?invite=${encodeURIComponent(inviteToken)}`
              : "/login"
          }
          className="auth-link"
        >
          {t("signIn")}
        </Link>
      </p>
    </AuthShell>
  );
}
