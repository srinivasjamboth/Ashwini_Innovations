import { requireOwner } from "@/lib/admin/guard";
import { PlanVault } from "@/components/admin/plan-vault";

/** Plan Vault — /ashwini-control/plan-vault (guard per page). */
export default async function PlanVaultPage() {
  await requireOwner();
  return <PlanVault />;
}
