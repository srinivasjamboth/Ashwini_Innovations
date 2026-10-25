import { requireOwner } from "@/lib/admin/guard";
import { MemberLedger } from "@/components/admin/member-ledger";

/** Member Ledger — /ashwini-control/member-ledger (guard per page). */
export default async function MemberLedgerPage() {
  await requireOwner();
  return <MemberLedger />;
}
