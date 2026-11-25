import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { executeGroupCsvImport, validateGroupCsv } from '@/lib/contacts/group-csv-import';
import { createGroup, normalizeGroupName, GROUP_NAME_MAX, GROUP_DESCRIPTION_MAX } from '@/lib/contacts/group-api';
import type { GroupColorKey } from '@/lib/contacts/group-colors';

export const maxDuration = 300;

/**
 * POST /api/contacts/groups/create-from-csv
 *
 * Validates CSV first. If validation passes, creates the group and executes the import.
 * Gated to 'agent' role.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`csv-create-group:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const rawName = typeof body?.name === 'string' ? body.name : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : null;
    const color = (typeof body?.color === 'string' ? body.color : 'sea') as GroupColorKey;
    const csvText = typeof body?.csvText === 'string' ? body.csvText : '';
    const fileName = typeof body?.fileName === 'string' ? body.fileName : 'import.csv';

    const name = normalizeGroupName(rawName);
    if (!name || name.length > GROUP_NAME_MAX) {
      return NextResponse.json(
        { error: `Group name is required (1-${GROUP_NAME_MAX} characters).` },
        { status: 400 }
      );
    }
    if (description && description.length > GROUP_DESCRIPTION_MAX) {
      return NextResponse.json(
        { error: `Description cannot exceed ${GROUP_DESCRIPTION_MAX} characters.` },
        { status: 400 }
      );
    }

    if (!csvText || csvText.trim().length === 0) {
      return NextResponse.json({ error: 'CSV content is empty.' }, { status: 400 });
    }

    // 1. Validate the file FIRST before creating any group
    const validation = await validateGroupCsv(supabase, accountId, csvText);
    if (!validation.ok) {
      return NextResponse.json(
        {
          error: validation.error,
          invalid_rows: validation.invalidRows,
        },
        { status: 400 }
      );
    }

    // 2. Validation passed! Now create the group
    let group;
    try {
      group = await createGroup(supabase, {
        accountId,
        name,
        description: description || undefined,
        color,
      });
    } catch (createErr) {
      return NextResponse.json(
        { error: createErr instanceof Error ? createErr.message : 'Failed to create group.' },
        { status: 400 }
      );
    }

    // 3. Create job row
    const { data: job, error: jobErr } = await supabase
      .from('contact_import_jobs')
      .insert({
        account_id: accountId,
        group_id: group.id,
        target_group_id: group.id,
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
      return NextResponse.json({ error: jobErr.message, group }, { status: 500 });
    }

    // 4. Run import
    const result = await executeGroupCsvImport({
      supabase,
      accountId,
      userId,
      groupId: group.id,
      csvText,
      fileName,
      existingJobId: job.id,
    });

    return NextResponse.json({
      ...result,
      group,
      jobId: result.jobId || job.id,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
