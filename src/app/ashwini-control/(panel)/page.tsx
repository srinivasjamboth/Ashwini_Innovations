import { requireOwner } from "@/lib/admin/guard";
import { getOwnerDisplayName } from "@/lib/admin/owner-profile";
import { PulseDashboard } from "@/components/admin/pulse-dashboard";

/**
 * Pulse — /ashwini-control. Guarded a SECOND time (the (panel) layout
 * already ran requireOwner for the shell); the spec's "every admin
 * page loader" rule, applied literally.
 */
export default async function PulsePage() {
  const { userId, email } = await requireOwner();
  const ownerName = await getOwnerDisplayName(userId, email);
  return <PulseDashboard ownerName={ownerName} />;
}
