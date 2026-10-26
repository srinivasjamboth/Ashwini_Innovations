import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/admin/guard";
import { getVaultDetail, getVaultPlanOptions } from "@/lib/admin/vault";
import { SubscriptionDetail } from "@/components/admin/subscription-detail";

/**
 * Subscription detail — /ashwini-control/plan-vault/[subscriptionId]
 * (spec Part 5). Deep-linkable: the loader re-runs on every request
 * (no-store via middleware), so a pasted link shows the same real data
 * as clicking through the Vault. Non-owner → requireOwner redirects /
 * 404s exactly like every other admin page; unknown or owner-owned
 * subscription → notFound (no data either way).
 */
export const dynamic = "force-dynamic";

export default async function SubscriptionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ subscriptionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId } = await requireOwner();
  const { subscriptionId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(subscriptionId)) notFound();

  const detail = await getVaultDetail(userId, subscriptionId);
  if (!detail) notFound();

  // Options for the update panel's plan select — same source as the
  // list page (plans + plan_prices, never hard-coded).
  const { plans } = await getVaultPlanOptions();

  // Deep-linked from the Member Ledger (spec Part 3)? Then the back link
  // returns to the ledger instead of the Vault — same page, no duplicate.
  const sp = await searchParams;
  const fromMemberLedger = sp.from === "member-ledger";

  return <SubscriptionDetail detail={detail} plans={plans} fromMemberLedger={fromMemberLedger} />;
}
