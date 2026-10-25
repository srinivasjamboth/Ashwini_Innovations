import { requireOwner } from "@/lib/admin/guard";
import { getOwnerDisplayName } from "@/lib/admin/owner-profile";
import { AdminShell } from "@/components/admin/admin-shell";

/**
 * Guarded admin shell. requireOwner() runs HERE (so every page under
 * the shell is behind it) and again inside each page component — the
 * spec's "middleware alone is not sufficient", repeated at every
 * layer that can answer a request.
 */
export default async function AdminPanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId, email } = await requireOwner();
  const ownerName = await getOwnerDisplayName(userId, email);

  return <AdminShell ownerName={ownerName}>{children}</AdminShell>;
}
