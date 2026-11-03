/**
 * CSV → broadcast audience.
 *
 * The broadcast wizard's "Upload CSV" audience type needs a
 * `{ phone, name }[]` list, which is a narrower shape than the
 * contacts importer's. Rather than re-parse, this reuses the shared
 * `parseContactCsv` + `dedupeByPhone` so a CSV that imports cleanly on
 * the Contacts page also broadcasts cleanly (issue #512).
 *
 * De-duplication happens HERE, on the normalized number, because the
 * downstream contact upsert inserts against a UNIQUE index on
 * (account_id, phone_normalized) (migration 022). Two spellings of the
 * same number in one file ("+1 555-0100" and "15550100") would
 * otherwise reach that index as separate inserts and fail the whole
 * broadcast with a constraint error.
 *
 * Pure and unit-tested: the wizard is a client component and
 * `vitest.config.ts` runs `environment: "node"` with no jsdom, so the
 * logic has to live outside the component to be testable.
 */

import { dedupeByPhone } from '@/lib/contacts/dedupe';
import {
  parseContactCsv,
  type ParsedContactRow,
} from '@/lib/contacts/parse-contact-csv';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

/** The shape the wizard hands to `createAndSendBroadcast`. */
export interface BroadcastCsvContact {
  phone: string;
  name?: string;
}

export type BroadcastCsvError =
  /** No `phone` header — the one column we can't work without. */
  | 'missing_phone_column'
  /** Header was fine, but not one row carried a usable number. */
  | 'no_valid_rows';

export type ParseBroadcastCsvResult =
  | {
      ok: true;
      contacts: BroadcastCsvContact[];
      /** Rows dropped as same-number repeats. */
      duplicates: number;
      /**
       * Rows dropped because the number is blank or lacks a leading `+`
       * and country code (issue #586). The wizard warns about these so
       * a CSV of national-format numbers doesn't silently shrink.
       */
      invalid: number;
    }
  | { ok: false; error: BroadcastCsvError };

export function parseBroadcastCsv(text: string): ParseBroadcastCsvResult {
  const { rows, hasPhoneColumn } = parseContactCsv(text);

  if (!hasPhoneColumn) return { ok: false, error: 'missing_phone_column' };

  const { unique, duplicates, invalid } = dedupeByPhone(rows);
  if (unique.length === 0) return { ok: false, error: 'no_valid_rows' };

  return {
    ok: true,
    // Drop email/company/tags: the broadcast audience only addresses
    // people, and `name` is the sole field template variables can map.
    contacts: unique.map(({ phone, name }) =>
      name ? { phone, name } : { phone }
    ),
    duplicates,
    invalid,
  };
}

// ---------------------------------------------------------------------------
// Duplicate-PRESERVING mode — the broadcast wizard's CSV audience.
//
// `parseBroadcastCsv` above collapses repeats (right for the Contacts
// importer, which must never create two contacts for one number). The
// broadcast wizard needs the opposite contract: every valid row is its
// own message, so a number appearing three times gets three recipient
// rows — while still creating at most ONE contact per number. Both
// truths are expressible: rows keep their own values, contacts dedupe
// on the normalized number. This function owns the row side; the
// contact side lives in use-broadcast-sending's keep-duplicates upsert.
// ---------------------------------------------------------------------------

/** One CSV row → one future recipient, values and line number intact. */
export interface BroadcastCsvRow {
  phone: string;
  /** Normalized digits-only key — matches contacts.phone_normalized. */
  key: string;
  /** 1-based physical CSV line, surfaced to the user everywhere. */
  sourceRow: number;
  name?: string;
  email?: string;
  company?: string;
}

export interface BroadcastCsvSkip {
  phone: string;
  name?: string;
  sourceRow: number;
  reason: 'invalid_phone';
}

export interface BroadcastCsvReview {
  /** Parsed data rows in the file (empty lines excluded), valid or not. */
  totalRows: number;
  /** Rows with a usable international number — i.e. rows kept. */
  validRows: number;
  /** Distinct normalized numbers among the valid rows. */
  uniqueNumbers: number;
  /** Valid rows beyond a number's first occurrence. */
  repeatedRows: number;
  skipped: BroadcastCsvSkip[];
}

export type ParseBroadcastCsvRowsResult =
  | {
      ok: true;
      rows: BroadcastCsvRow[];
      review: BroadcastCsvReview;
    }
  | { ok: false; error: BroadcastCsvError };

export function parseBroadcastCsvRows(
  text: string,
): ParseBroadcastCsvRowsResult {
  // withRowNumbers keeps the contacts-importer contract untouched while
  // giving this mode the physical line of every record.
  const { rows, hasPhoneColumn } = parseContactCsv(text, true);

  if (!hasPhoneColumn) return { ok: false, error: 'missing_phone_column' };

  const kept: BroadcastCsvRow[] = [];
  const skipped: BroadcastCsvSkip[] = [];
  const seen = new Set<string>();
  let repeatedRows = 0;

  for (const row of rows as ParsedContactRow[]) {
    const key = parseInternationalPhone(row.phone);
    const sourceRow = row.sourceRow ?? kept.length + 2; // header + 1 fallback
    if (!key) {
      // Blank or national-format number (issue #586): never sent, always
      // listed, so a `+`-stripped spreadsheet is visible before sending.
      skipped.push({ phone: row.phone, name: row.name, sourceRow, reason: 'invalid_phone' });
      continue;
    }
    if (seen.has(key)) repeatedRows++;
    seen.add(key);
    kept.push({
      phone: row.phone,
      key,
      sourceRow,
      name: row.name,
      email: row.email,
      company: row.company,
    });
  }

  if (kept.length === 0) return { ok: false, error: 'no_valid_rows' };

  return {
    ok: true,
    rows: kept,
    review: {
      totalRows: rows.length,
      validRows: kept.length,
      uniqueNumbers: seen.size,
      repeatedRows,
      skipped,
    },
  };
}
