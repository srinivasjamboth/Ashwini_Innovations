import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { executeGroupCsvImport, validateGroupCsv } from '@/lib/contacts/group-csv-import';
import { getGroup } from '@/lib/contacts/group-api';

export const maxDuration = 300;

/**
 * POST /api/contacts/groups/[groupId]/import-csv
 *
 * Import contacts from CSV into an existing contact group.
 * Gated to 'agent' role.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ groupId: string }> }
) {
  try {
    const { groupId } = await params;
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`csv-import:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    // Verify group exists and belongs to this account
    const group = await getGroup(supabase, groupId);
    if (!group) {
      return NextResponse.json({ error: 'Group not found.' }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const csvText = typeof body?.csvText === 'string' ? body.csvText : '';
    const fileName = typeof body?.fileName === 'string' ? body.fileName : 'import.csv';

    if (!csvText || csvText.trim().length === 0) {
      return NextResponse.json({ error: 'CSV content is empty.' }, { status: 400 });
    }

    // 1. Pre-validate
    const validation = await validateGroupCsv(supabase, accountId, csvText);
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error, invalid_rows: validation.invalidRows },
        { status: 400 }
      );
    }

    // 2. Create job row
    const { data: job, error: jobErr } = await supabase
      .from('contact_import_jobs')
      .insert({
        account_id: accountId,
        group_id: groupId,
        target_group_id: groupId,
        created_by: userId,
        file_name: fileName,
        status: 'running',
        total_rows: validation.totalRows,
        valid_rows: validation.uniqueRowsByKey.size,
        repeats_count: validation.repeatsCount,
        invalid_count: validation.invalidRows.length,
        invalid_rows: validation.invalidRows,
      })
      .select('id')
      .single();

    if (jobErr) {
      return NextResponse.json({ error: jobErr.message }, { status: 500 });
    }

    // 3. Execute import
    const result = await executeGroupCsvImport({
      supabase,
      accountId,
      userId,
      groupId,
      csvText,
      fileName,
      existingJobId: job.id,
    });

    return NextResponse.json({
      ...result,
      jobId: result.jobId || job.id,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
