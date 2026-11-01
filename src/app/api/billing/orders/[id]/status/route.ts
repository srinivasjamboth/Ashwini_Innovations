import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { getOrderStatus } from '@/lib/plans/orders';

export const dynamic = 'force-dynamic';

/**
 * GET /api/billing/orders/:id/status — the UI's confirmation poll (spec
 * PART 3.6).
 *
 * Used while the customer is in the "Confirming your payment..." window
 * (UPI settled in another app, tab closed mid-redirect, webhook racing the
 * browser). Returns just enough to drive that copy: created / attempted /
 * paid / failed, plus the plan, cycle, amount, method, period end and
 * payment id once known.
 *
 * Tenant-scoped: the order is read through `getOrderStatus(orderId,
 * accountId)`, which returns null when the row belongs to a different
 * account. Any authenticated member of the owning account can poll their
 * own order.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const { id } = await params;
  const status = await getOrderStatus(id, ctx.accountId);
  if (!status) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
}
