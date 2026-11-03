/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
  /**
   * 1-based physical CSV line where this record starts. Only populated
   * when `parseContactCsv` is called with `withRowNumbers` — the
   * contacts importer never reads it, and the broadcast wizard's
   * duplicate-preserving mode uses it to show each recipient which row
   * of the uploaded file produced them.
   */
  sourceRow?: number;
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /**
   * True when the CSV header includes the required `phone` column.
   * `rows` is empty both when the column is missing and when the file
   * simply has no usable data rows; callers that need to tell those
   * apart (to pick the right error message) read this flag.
   */
  hasPhoneColumn: boolean;
  /** True when the CSV header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a `company` column. */
  hasCompanyColumn: boolean;
}

export function parseContactCsv(text: string, withRowNumbers = false): ParseContactCsvResult {
  // Excel writes a UTF-8 BOM at the start of "CSV UTF-8" exports; left in
  // place it becomes part of the first header cell ("\uFEFFphone") and the
  // phone column silently disappears from the header scan.
  const records = scanCsvRecords(stripBom(text));
  if (records.length < 2) {
    return {
      rows: [],
      hasPhoneColumn: false,
      hasTagsColumn: false,
      hasCompanyColumn: false,
    };
  }

  // Record 0 is the header line; the remainder are data records. Scan
  // is quote-aware, so a quoted cell containing a newline stays ONE
  // record (splitting on raw newlines used to tear such rows in half).
  const headers = records[0].text
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  // The number can arrive as a single `phone` column (legacy: E.164 with a
  // leading `+`) or as a `whatsapp` column paired with a separate
  // `countrycode` column (the sample format: no `+`, country code split out
  // into its own column). Either header is accepted; when both are present
  // `phone` wins so existing files behave exactly as before.
  const phoneIdx = headers.indexOf('phone');
  const whatsappIdx = headers.indexOf('whatsapp');
  const countryCodeIdx = headers.indexOf('countrycode');
  const numberIdx = phoneIdx !== -1 ? phoneIdx : whatsappIdx;

  if (numberIdx === -1) {
    return {
      rows: [],
      hasPhoneColumn: false,
      hasTagsColumn: false,
      hasCompanyColumn: false,
    };
  }

  const nameIdx = headers.indexOf('name');
  const emailIdx = headers.indexOf('email');
  const companyIdx = headers.indexOf('company');
  const tagsIdx = headers.indexOf('tags');

  const rows: ParsedContactRow[] = [];

  for (let i = 1; i < records.length; i++) {
    const line = records[i].text.trim();
    if (!line) continue;

    const values = parseCsvLine(line);
    // A row with no usable phone is pushed through rather than dropped
    // here — dedupeByPhone (shared with the webhook/manual-form paths)
    // already treats an empty normalized key as invalid, and counting
    // it there means the import result can tell the user "N contacts
    // had no phone" instead of the row just vanishing with the total
    // row count silently short of what's actually in the file.
    const numberRaw = values[numberIdx]?.replace(/["']/g, '').trim() ?? '';
    const countryCodeRaw =
      countryCodeIdx >= 0
        ? values[countryCodeIdx]?.replace(/["']/g, '').trim() ?? ''
        : '';
    const phone = composeInternationalPhone(numberRaw, countryCodeRaw);

    rows.push({
      phone,
      name:
        nameIdx >= 0
          ? values[nameIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      email:
        emailIdx >= 0
          ? values[emailIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      company:
        companyIdx >= 0
          ? values[companyIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      tagNames:
        tagsIdx >= 0 ? parseTagCell(values[tagsIdx]?.replace(/["']/g, '')) : [],
      // Set only when requested — callers that don't ask get byte-identical
      // row objects to before, which their equality checks depend on.
      ...(withRowNumbers ? { sourceRow: records[i].line } : {}),
    });
  }

  return {
    rows,
    hasPhoneColumn: true,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
  };
}

/**
 * Combine a (possibly national) number with an optional separate country
 * code into the international form the rest of the pipeline expects.
 *
 * - Already international (`+91 98765 43210`) → returned untouched; the
 *   `+` is load-bearing for `parseInternationalPhone`, so we never strip it.
 * - National number + a `countrycode` cell (`9876543210` + `91`) →
 *   `+919876543210`. This is what lets the sample CSV omit the `+`.
 * - National number with no country code → returned as-is so it is still
 *   counted invalid downstream (issue #586) rather than guessed a country.
 */
export function composeInternationalPhone(
  number: string,
  countryCode: string
): string {
  const raw = number.trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return raw;

  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;

  const cc = countryCode.replace(/\D/g, '');
  return cc ? `+${cc}${digits}` : raw;
}

/** Strip the leading UTF-8 BOM Excel prepends to "CSV UTF-8" exports. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split CSV text into logical records, honouring quoted fields that
 * contain newlines. `line` is the 1-based physical line the record
 * starts on — what the broadcast review shows next to each recipient.
 *
 * Quote tracking works on whole chunks (a lone `"` inside an unquoted
 * cell is dropped downstream by the cell scrubbers anyway), so an odd
 * number of quotes in one line merely extends the record to the line
 * that closes it rather than corrupting the fields before it.
 */
function scanCsvRecords(text: string): { text: string; line: number }[] {
  const physical = text.split(/\r?\n/);
  const records: { text: string; line: number }[] = [];
  let current: string[] = [];
  let quoteCount = 0;
  let startLine = 1;

  physical.forEach((chunk, idx) => {
    if (current.length === 0) startLine = idx + 1;
    current.push(chunk);
    for (const char of chunk) {
      if (char === '"') quoteCount++;
    }
    // Even quote count = no open quoted cell = record complete.
    if (quoteCount % 2 === 0) {
      records.push({ text: current.join('\n'), line: startLine });
      current = [];
      quoteCount = 0;
    }
  });
  // Unterminated quote at EOF: flush what's left so the row is at least
  // visible (invalid) instead of silently vanishing.
  if (current.length > 0) records.push({ text: current.join('\n'), line: startLine });

  // Keep the original leading/trailing-whitespace semantics: global trim
  // on the first record (BOM/indent before the header) and drop records
  // that are blank after trimming, exactly as the line-split version did.
  if (records.length > 0) records[0] = { text: records[0].text.trim(), line: 1 };
  return records;
}

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
