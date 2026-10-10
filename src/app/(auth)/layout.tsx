import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./auth-shell.css";

// Shared metadata for auth pages (login / signup / forgot-password).
// None of these should be indexed — they'd compete with the marketing
// landing in SERPs and offer nothing to a searcher who hasn't already
// signed up. Each page still gets its own <title> via its own
// metadata.title override below the route group layout.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  // No wrapper element: each page renders its own `AuthShell`, which is
  // the full-viewport flex container the stylesheet positions the panel
  // inside. Adding a div here would put a static block parent between
  // them and break the panel's absolute geometry.
  return children;
}
