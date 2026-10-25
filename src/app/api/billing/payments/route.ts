import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/plans/admin-client';

/**
 * GET /api/billing/payments
 *
 * Payment history for the billing settings tab (Part 5: billing tab shows
 * "payment history"). Readable by any account member; scoped to the
 * caller's account. Reads via service-role and filters on account_id
 * explicitly, matching the tenancy style used across the app.
 */
export async function GET() {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const { data, error } = await supabaseAdmin()
    .from('payment_transactions')
    .select('id,plan_id,billing_cycle,gateway,amount,currency,status,created_at')
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[billing/payments] failed:', error.message);
    return NextResponse.json({ error: 'Could not load payments' }, { status: 500 });
  }
  return NextResponse.json({ payments: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } });
}
