import type { Metadata } from "next";
import { AdminLoginForm } from "@/components/admin/admin-login-form";
// The owner's page reuses the client auth shell's design. Its stylesheet
// is normally pulled in by the (auth) route-group layout, which does not
// wrap this subtree, so import it here to keep the two sign-ins identical.
import "../../(auth)/auth-shell.css";

/**
 * /ashwini-control/login — the owner's only way in.
 *
 * Email + password, nothing else: no signup, no forgot-password link,
 * no social login. The panel copy, the generic-error contract, and the
 * throttle live in the API route (src/app/api/ashwini-control/login)
 * and lib/admin/throttle; this file is just the form chrome.
 */
export const metadata: Metadata = {
  title: "Sign in",
};

// Render per request: a prerendered snapshot would be served with
// Next's static cache headers, defeating the no-store the middleware
// stamps across the whole admin subtree.
export const dynamic = "force-dynamic";

export default function AdminLoginPage() {
  return <AdminLoginForm />;
}
