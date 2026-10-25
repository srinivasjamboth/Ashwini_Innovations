import type { Metadata } from "next";

/**
 * Super Admin area root layout — deliberately a pass-through.
 *
 * It carries only the "never index this subtree" metadata (the real
 * X-Robots-Tag header is set by middleware on every /ashwini-control
 * response). The guard lives one level down in (panel)/layout.tsx so
 * the login page itself — which must be reachable WITHOUT a session —
 * is not accidentally locked out by it.
 *
 * Nothing on the public site or the client dashboard links here;
 * robots.txt disallows the path; the sitemap has no admin entries.
 */
export const metadata: Metadata = {
  title: {
    default: "Admin — Ashwini Innovations",
    template: "%s — Admin",
  },
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

export default function AdminRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* The Super Admin area is ALWAYS light, whatever mode the
          owner's browser prefers for the client app. Every surface
          token in globals.css keys off html[data-mode], so flipping
          that attribute here (runs synchronously as the chunk is
          parsed, before the admin content paints) is the whole
          mechanism — no component-level overrides needed, and the
          user's saved client preference in localStorage is never
          touched. Leaving via logout is a full page load, where the
          root boot script restores their chosen mode.

          data-admin="1" is set by the SAME script for the same reason:
          it scopes the dark sea-blue admin palette (globals.css
          "Super Admin area" block — --primary/--ring/--chart-* + the
          --sea-* tokens) to this subtree only. The customer app never
          renders with this attribute, so nothing outside the admin
          area can be affected. */}
      <script dangerouslySetInnerHTML={{ __html: "try{document.documentElement.dataset.mode='light';document.documentElement.dataset.admin='1'}catch(e){}" }} />
      {children}
    </>
  );
}
