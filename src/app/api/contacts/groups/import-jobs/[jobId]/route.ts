import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

/**
 * GET /api/contacts/groups/import-jobs/[jobId]
 *
 * Polls progress and reads the status/summary of an import job.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;
    const { supabase, accountId } = await requireRole('agent');

    const { data: job, error } = await supabase
      .from('contact_import_jobs')
      .select('*')
      .eq('id', jobId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (error || !job) {
      return NextResponse.json({ error: 'Import job not found.' }, { status: 404 });
    }

    return NextResponse.json({ job });
  } catch (err) {
    return toErrorResponse(err);
  }
}
