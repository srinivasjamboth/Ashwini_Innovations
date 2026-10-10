"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Loader2, Lock, Mail } from "lucide-react";
import {
  AuthAlert,
  AuthField,
  AuthShell,
} from "@/components/auth/auth-shell";

// `useSearchParams` opts the component out of static prerendering
// unless it sits under a Suspense boundary. We split the form into
// a child component so the outer page can prerender the chrome
// (panel, card frame) while the form hydrates with the query string
// on the client.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("LoginPage");
  // Set by /auth/callback when an emailed link (confirmation, password
  // reset) could not be turned into a session — see src/lib/auth/callback.ts.
  const linkError = searchParams.get("error");
  const linkErrorMessage =
    linkError === "link_expired"
      ? t("linkExpired")
      : linkError === "link_invalid"
        ? t("linkInvalid")
        : null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // Full-page navigation (not router.push) so the browser issues a
    // fresh top-level request that carries the just-written Supabase
    // auth cookies to the middleware gating /dashboard. A soft
    // client-side navigation can reach the protected route before the
    // server observes the new session, so the middleware bounces it
    // back to /login — which looks like the page "just refreshing"
    // instead of signing in (issue #365). Mirrors the deliberate full
    // reload the invite-accept flow already uses in join/[token].
    const destination = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/dashboard";
    window.location.href = destination;
  };

  return (
    <AuthShell mode="sign-in">
      <h1 className="auth-title">
        {inviteToken ? t("titleAccept") : t("titleWelcome")}
      </h1>
      <p className="auth-subtitle">
        {inviteToken ? t("descAccept") : t("descWelcome")}
      </p>

      <form onSubmit={handleLogin}>
        {linkErrorMessage && !error && (
          <AuthAlert tone="warn">{linkErrorMessage}</AuthAlert>
        )}
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

        <AuthField
          icon={Lock}
          type="password"
          name="password"
          autoComplete="current-password"
          label={t("passwordLabel")}
          placeholder={t("passwordPlaceholder")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={loading}
        />

        <div className="auth-row">
          <Link href="/forgot-password" className="auth-link">
            {t("forgotPassword")}
          </Link>
        </div>

        <button type="submit" className="auth-submit" disabled={loading}>
          {loading && <Loader2 className="auth-spin" aria-hidden={true} />}
          {loading ? t("signingIn") : t("signIn")}
        </button>
      </form>

      <p className="auth-switch">
        {t("noAccount")}{" "}
        <Link
          href={
            inviteToken
              ? `/signup?invite=${encodeURIComponent(inviteToken)}`
              : "/signup"
          }
          className="auth-link"
        >
          {t("createAccount")}
        </Link>
      </p>
    </AuthShell>
  );
}
