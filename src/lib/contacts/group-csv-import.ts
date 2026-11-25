import type { SupabaseClient } from '@supabase/supabase-js';
import { parseContactCsv, type ParsedContactRow } from '@/lib/contacts/parse-contact-csv';
import { normalizeKey } from '@/lib/contacts/dedupe';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { checkLimit } from '@/lib/plans/entitlements';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import type { Contact } from '@/types';

export interface InvalidRowDetail {
  row: number;
  phone?: string;
  name?: string;
  reason: string;
}

export interface GroupCsvImportResult {
  jobId: string;
  success: boolean;
  total_rows: number;
  valid_rows: number;
  new_contacts_count: number;
  existing_added_count: number;
  already_in_group_count: number;
  repeats_count: number;
  invalid_count: number;
  invalid_rows: InvalidRowDetail[];
  error?: string;
}

export interface ValidateGroupCsvResult {
  ok: boolean;
  error?: string;
  parsedRows: ParsedContactRow[];
  uniqueRowsByKey: Map<string, ParsedContactRow>;
  missingKeys: string[];
  existingContactsByKey: Map<string, Contact>;
  repeatsCount: number;
  invalidRows: InvalidRowDetail[];
  totalRows: number;
}

const IN_CHUNK = 200;

/**
 * Validate a CSV file before creating a group or running an import.
 * Ensures required columns exist, normalizes numbers, tracks file repeats
 * and invalid rows, checks existing contacts, and validates against plan limits.
 */
export async function validateGroupCsv(
  supabase: SupabaseClient,
  accountId: string,
  csvText: string,
): Promise<ValidateGroupCsvResult> {
  const { rows, hasPhoneColumn } = parseContactCsv(csvText, true);

  if (!hasPhoneColumn) {
    return {
      ok: false,
      error: 'CSV header must include a phone or whatsapp column (and countrycode if not international).',
      parsedRows: [],
      uniqueRowsByKey: new Map(),
      missingKeys: [],
      existingContactsByKey: new Map(),
      repeatsCount: 0,
      invalidRows: [],
      totalRows: 0,
    };
  }

  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const totalRows = Math.max(0, lines.length - 1); // Exclude header line

  const uniqueRowsByKey = new Map<string, ParsedContactRow>();
  const invalidRows: InvalidRowDetail[] = [];
  let repeatsCount = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    const lineNum = r.sourceRow ?? idx + 2;

    if (!r.phone || !r.phone.trim()) {
      invalidRows.push({
        row: lineNum,
        name: r.name,
        reason: 'Empty or blank phone number',
      });
      continue;
    }

    const normalizedDigits = parseInternationalPhone(r.phone);
    if (!normalizedDigits) {
      invalidRows.push({
        row: lineNum,
        phone: r.phone,
        name: r.name,
        reason: 'Invalid international phone number. Must include a valid country code (e.g. +91 9876543210).',
      });
      continue;
    }

    if (uniqueRowsByKey.has(normalizedDigits)) {
      repeatsCount++;
      continue;
    }

    uniqueRowsByKey.set(normalizedDigits, r);
  }

  const uniqueKeys = Array.from(uniqueRowsByKey.keys());
  const existingContactsByKey = new Map<string, Contact>();

  // Lookup existing contacts in chunks of 500 to stay under PostgREST IN caps
  for (let i = 0; i < uniqueKeys.length; i += 500) {
    const chunk = uniqueKeys.slice(i, i + 500);
    const { data: existing, error: lookupErr } = await supabase
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .in('phone_normalized', chunk);

    if (lookupErr) {
      throw new Error(`Failed to check existing contacts: ${lookupErr.message}`);
    }

    for (const c of (existing ?? []) as Contact[]) {
      const k = normalizeKey(c.phone ?? '');
      if (k) existingContactsByKey.set(k, c);
    }
  }

  const missingKeys = uniqueKeys.filter((k) => !existingContactsByKey.has(k));

  // Plan enforcement: only NEW unique contacts count toward the limit
  if (missingKeys.length > 0) {
    const limitCheck = await checkLimit(accountId, 'contacts', missingKeys.length);
    if (!limitCheck.allowed) {
      if (limitCheck.reason === 'subscription_expired') {
        return {
          ok: false,
          error: 'Your subscription has expired. Please upgrade or renew your plan before adding contacts.',
          parsedRows: rows,
          uniqueRowsByKey,
          missingKeys,
          existingContactsByKey,
          repeatsCount,
          invalidRows,
          totalRows,
        };
      }
      return {
        ok: false,
        error: `This import contains ${missingKeys.length} new contact(s), but your plan has only ${limitCheck.remaining} slot(s) remaining (${limitCheck.current} of ${limitCheck.limit} used). Please upgrade your plan or reduce the list.`,
        parsedRows: rows,
        uniqueRowsByKey,
        missingKeys,
        existingContactsByKey,
        repeatsCount,
        invalidRows,
        totalRows,
      };
    }
  }

  return {
    ok: true,
    parsedRows: rows,
    uniqueRowsByKey,
    missingKeys,
    existingContactsByKey,
    repeatsCount,
    invalidRows,
    totalRows,
  };
}

/**
 * Shared worker that executes the CSV import into a group (or without a group).
 * Creates genuinely new contacts with attributes, preserves existing contacts,
 * and assigns group membership idempotently.
 */
export async function executeGroupCsvImport(params: {
  supabase: SupabaseClient;
  accountId: string;
  userId: string;
  groupId: string | null;
  csvText: string;
  fileName?: string;
  existingJobId?: string;
}): Promise<GroupCsvImportResult> {
  const {
    supabase,
    accountId,
    userId,
    groupId,
    csvText,
    fileName,
    existingJobId,
  } = params;

  let jobId = existingJobId;

  // 1. Ensure a job row exists
  if (!jobId) {
    const { data: job, error: jobErr } = await supabase
      .from('contact_import_jobs')
      .insert({
        account_id: accountId,
        group_id: groupId,
        target_group_id: groupId,
        created_by: userId,
        file_name: fileName ?? 'import.csv',
        status: 'running',
      })
      .select('id')
      .single();

    if (jobErr) {
      throw new Error(`Failed to initialize import job: ${jobErr.message}`);
    }
    jobId = job.id;
  } else {
    await supabase
      .from('contact_import_jobs')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', jobId);
  }

  try {
    // 2. Validate & parse
    const validation = await validateGroupCsv(supabase, accountId, csvText);
    if (!validation.ok) {
      await supabase
        .from('contact_import_jobs')
        .update({
          status: 'failed',
          error_message: validation.error,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);

      return {
        jobId: jobId ?? '',
        success: false,
        total_rows: validation.totalRows,
        valid_rows: validation.uniqueRowsByKey.size,
        new_contacts_count: 0,
        existing_added_count: 0,
        already_in_group_count: 0,
        repeats_count: validation.repeatsCount,
        invalid_count: validation.invalidRows.length,
        invalid_rows: validation.invalidRows,
        error: validation.error,
      };
    }

    const {
      uniqueRowsByKey,
      missingKeys,
      existingContactsByKey,
      repeatsCount,
      invalidRows,
      totalRows,
    } = validation;

    // 3. Resolve custom fields for attributes
    const attributeNames = new Set<string>();
    for (const row of uniqueRowsByKey.values()) {
      if (row.attributes) {
        for (const attr of Object.keys(row.attributes)) {
          attributeNames.add(attr.trim());
        }
      }
    }

    const customFieldIdByName = new Map<string, string>();
    if (attributeNames.size > 0) {
      const { data: existingFields } = await supabase
        .from('custom_fields')
        .select('id, field_name')
        .eq('account_id', accountId);

      for (const f of existingFields ?? []) {
        customFieldIdByName.set(f.field_name.toLowerCase().trim(), f.id);
      }

      for (const attr of attributeNames) {
        const key = attr.toLowerCase().trim();
        if (!customFieldIdByName.has(key)) {
          const { data: createdField, error: createFieldErr } = await supabase
            .from('custom_fields')
            .insert({
              account_id: accountId,
              field_name: attr.trim(),
              field_type: 'text',
            })
            .select('id')
            .single();

          if (!createFieldErr && createdField) {
            customFieldIdByName.set(key, createdField.id);
          }
        }
      }
    }

    // 4. Resolve tags
    const allTagNames = Array.from(uniqueRowsByKey.values()).flatMap((r) => r.tagNames);
    let tagIdByKey = new Map<string, string>();
    if (allTagNames.length > 0) {
      const resolved = await resolveImportTagIds(supabase, {
        accountId,
        userId,
        tagNames: allTagNames,
        canCreateTags: true,
      });
      tagIdByKey = resolved.tagIdByKey;
    }

    // 5. Create new contacts
    const newContactsToInsert = missingKeys.map((k) => {
      const row = uniqueRowsByKey.get(k)!;
      return {
        user_id: userId,
        account_id: accountId,
        phone: row.phone,
        name: row.name || null,
        email: row.email || null,
        company: row.company || null,
        source: 'csv_upload',
      };
    });

    const newlyCreatedContactIds: string[] = [];
    const contactIdByKey = new Map<string, string>();

    // Copy existing contact ids to map
    for (const [k, c] of existingContactsByKey.entries()) {
      contactIdByKey.set(k, c.id);
    }

    const INSERT_CHUNK = 100;
    for (let i = 0; i < newContactsToInsert.length; i += INSERT_CHUNK) {
      const batch = newContactsToInsert.slice(i, i + INSERT_CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from('contacts')
        .insert(batch)
        .select('id, phone_normalized');

      if (!insertErr && inserted) {
        for (const row of inserted) {
          newlyCreatedContactIds.push(row.id);
          if (row.phone_normalized) contactIdByKey.set(row.phone_normalized, row.id);
        }
      } else {
        // Individual fallback on error (e.g. 23505 race condition)
        for (const contact of batch) {
          const { data: single, error: singleErr } = await supabase
            .from('contacts')
            .insert(contact)
            .select('id, phone_normalized')
            .single();

          if (!singleErr && single) {
            newlyCreatedContactIds.push(single.id);
            if (single.phone_normalized) contactIdByKey.set(single.phone_normalized, single.id);
          }
        }
      }
    }

    // Re-read any still missing keys in case of race inserts
    const unmappedKeys = missingKeys.filter((k) => !contactIdByKey.has(k));
    if (unmappedKeys.length > 0) {
      for (let i = 0; i < unmappedKeys.length; i += 500) {
        const chunk = unmappedKeys.slice(i, i + 500);
        const { data: reread } = await supabase
          .from('contacts')
          .select('id, phone_normalized')
          .eq('account_id', accountId)
          .in('phone_normalized', chunk);

        for (const r of reread ?? []) {
          if (r.phone_normalized) contactIdByKey.set(r.phone_normalized, r.id);
        }
      }
    }

    // 6. Assign attributes & tags for newly created contacts
    const customValuesToInsert: {
      contact_id: string;
      custom_field_id: string;
      value: string;
    }[] = [];

    const contactTagsToInsert: {
      contact_id: string;
      tag_id: string;
    }[] = [];

    for (const k of missingKeys) {
      const contactId = contactIdByKey.get(k);
      const row = uniqueRowsByKey.get(k);
      if (!contactId || !row) continue;

      if (row.attributes) {
        for (const [attrName, val] of Object.entries(row.attributes)) {
          const fieldId = customFieldIdByName.get(attrName.toLowerCase().trim());
          if (fieldId && val) {
            customValuesToInsert.push({
              contact_id: contactId,
              custom_field_id: fieldId,
              value: val,
            });
          }
        }
      }

      for (const t of row.tagNames) {
        const tagId = tagIdByKey.get(t.toLowerCase().trim());
        if (tagId) {
          contactTagsToInsert.push({
            contact_id: contactId,
            tag_id: tagId,
          });
        }
      }
    }

    if (customValuesToInsert.length > 0) {
      for (let i = 0; i < customValuesToInsert.length; i += 200) {
        await supabase
          .from('contact_custom_values')
          .insert(customValuesToInsert.slice(i, i + 200));
      }
    }

    if (contactTagsToInsert.length > 0) {
      for (let i = 0; i < contactTagsToInsert.length; i += 200) {
        await supabase
          .from('contact_tags')
          .insert(contactTagsToInsert.slice(i, i + 200));
      }
    }

    // 7. Group Membership Management
    let alreadyInGroupCount = 0;
    let existingAddedCount = 0;
    let newContactsAddedCount = 0;

    if (groupId) {
      const allContactIds = Array.from(uniqueRowsByKey.keys())
        .map((k) => contactIdByKey.get(k))
        .filter((id): id is string => Boolean(id));

      const existingMembersSet = new Set<string>();

      for (let i = 0; i < allContactIds.length; i += 500) {
        const slice = allContactIds.slice(i, i + 500);
        const { data: memberRows } = await supabase
          .from('contact_group_members')
          .select('contact_id')
          .eq('group_id', groupId)
          .in('contact_id', slice);

        for (const m of memberRows ?? []) {
          existingMembersSet.add(m.contact_id);
        }
      }

      const membersToInsert: { group_id: string; contact_id: string; added_by: string }[] = [];
      const newContactIdSet = new Set(newlyCreatedContactIds);

      for (const cid of allContactIds) {
        if (existingMembersSet.has(cid)) {
          alreadyInGroupCount++;
        } else {
          membersToInsert.push({
            group_id: groupId,
            contact_id: cid,
            added_by: userId,
          });
          if (newContactIdSet.has(cid)) {
            newContactsAddedCount++;
          } else {
            existingAddedCount++;
          }
        }
      }

      for (let i = 0; i < membersToInsert.length; i += IN_CHUNK) {
        const batch = membersToInsert.slice(i, i + IN_CHUNK);
        await supabase
          .from('contact_group_members')
          .insert(batch);
      }
    } else {
      newContactsAddedCount = newlyCreatedContactIds.length;
    }

    // 8. Update job record
    const summary: GroupCsvImportResult = {
      jobId: jobId ?? '',
      success: true,
      total_rows: totalRows,
      valid_rows: uniqueRowsByKey.size,
      new_contacts_count: newContactsAddedCount,
      existing_added_count: existingAddedCount,
      already_in_group_count: alreadyInGroupCount,
      repeats_count: repeatsCount,
      invalid_count: invalidRows.length,
      invalid_rows: invalidRows,
    };

    await supabase
      .from('contact_import_jobs')
      .update({
        status: 'done',
        total_rows: totalRows,
        processed_rows: totalRows,
        valid_rows: uniqueRowsByKey.size,
        new_contacts_count: newContactsAddedCount,
        existing_added_count: existingAddedCount,
        already_in_group_count: alreadyInGroupCount,
        repeats_count: repeatsCount,
        invalid_count: invalidRows.length,
        invalid_rows: invalidRows,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed';
    await supabase
      .from('contact_import_jobs')
      .update({
        status: 'failed',
        error_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    throw err;
  }
}
