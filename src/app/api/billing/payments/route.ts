import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { listPaymentHistory } from '@/lib/plans/orders';

export const dynamic = 'force-dynamic';

/**
 * GET /api/billing/payments — payment history for the billing tab (spec
 * PART 3.7): date, plan, cycle, amount, method, status, payment id.
 *
 * Readable by any account member and scoped to the caller's account.
 * `payment_orders` is the authoritative record for the Orders flow; legacy
 * paid `payment_transactions` with no matching order are merged in by
 * `listPaymentHistory`, so an existing (Subscriptions-model) customer's
 * history never loses a row.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  try {
    const payments = await listPaymentHistory(ctx.accountId);
    return NextResponse.json({ payments }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[billing/payments] failed:', err);
    return NextResponse.json({ error: 'Could not load payments' }, { status: 500 });
  }
}
