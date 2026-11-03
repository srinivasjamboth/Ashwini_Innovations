import { describe, expect, it } from 'vitest';
import { parseBroadcastCsv, parseBroadcastCsvRows } from './broadcast-csv';

describe('parseBroadcastCsv', () => {
  it('parses phone + name into the audience shape', () => {
    const result = parseBroadcastCsv(
      `phone,name
+15551230000,Ada
+15559990000,Grace`
    );

    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [
        { phone: '+15551230000', name: 'Ada' },
        { phone: '+15559990000', name: 'Grace' },
      ],
    });
  });

  it('omits name when the column is absent', () => {
    const result = parseBroadcastCsv(`phone\n+15551230000`);
    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [{ phone: '+15551230000' }],
    });
  });

  it('drops the extra columns the importer understands', () => {
    const result = parseBroadcastCsv(
      `phone,name,email,company,tags
+15551230000,Ada,ada@example.com,Analytical Engines,"VIP, Lead"`
    );
    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [{ phone: '+15551230000', name: 'Ada' }],
    });
  });

  it('tolerates any column order', () => {
    const result = parseBroadcastCsv(`name,phone\nAda,+15551230000`);
    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [{ phone: '+15551230000', name: 'Ada' }],
    });
  });

  // The downstream upsert inserts against UNIQUE (account_id,
  // phone_normalized) (migration 022). If two spellings of one number
  // both reached it, the whole broadcast would die on a 23505 — so
  // collapsing them here is the fix, not a nicety.
  it('collapses differently-formatted spellings of the same number', () => {
    const result = parseBroadcastCsv(
      `phone,name
+1 (555) 123-0000,Ada
+1-555-123-0000,Ada Again`
    );

    expect(result).toEqual({
      ok: true,
      duplicates: 1,
      invalid: 0,
      contacts: [{ phone: '+1 (555) 123-0000', name: 'Ada' }],
    });
  });

  // A national-format number has no country code, so Meta reads its
  // leading digits as one: "4155551212" (US) is delivered to +41
  // (Switzerland). Rows without a leading `+` are refused and counted,
  // not silently dropped, so a whole-file export from a spreadsheet that
  // stripped the `+` is visible to the user before anything is sent
  // (issue #586).
  it('rejects rows without a leading + and reports them as invalid', () => {
    const result = parseBroadcastCsv(
      `phone,name
4155551212,National US
+14155551212,Ada
9876543210,National IN`
    );

    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 2,
      contacts: [{ phone: '+14155551212', name: 'Ada' }],
    });
  });

  it('reports no_valid_rows when every number lacks a country code', () => {
    expect(parseBroadcastCsv(`phone,name\n4155551212,Ada`)).toEqual({
      ok: false,
      error: 'no_valid_rows',
    });
  });

  it('reports a missing phone header distinctly from an empty file', () => {
    expect(parseBroadcastCsv(`name,email\nAda,ada@example.com`)).toEqual({
      ok: false,
      error: 'missing_phone_column',
    });
    // No header at all reads the same way — there is no `phone` column.
    expect(parseBroadcastCsv('')).toEqual({
      ok: false,
      error: 'missing_phone_column',
    });
  });

  it('reports no_valid_rows when the header is good but no number is', () => {
    expect(parseBroadcastCsv(`phone,name\n,Ada\n"",Grace`)).toEqual({
      ok: false,
      error: 'no_valid_rows',
    });
  });

  it('handles CRLF line endings and a trailing newline', () => {
    const result = parseBroadcastCsv(
      'phone,name\r\n+15551230000,Ada\r\n+15559990000,Grace\r\n'
    );
    expect(result).toEqual({
      ok: true,
      duplicates: 0,
      invalid: 0,
      contacts: [
        { phone: '+15551230000', name: 'Ada' },
        { phone: '+15559990000', name: 'Grace' },
      ],
    });
  });
});

describe('parseBroadcastCsvRows (duplicate-preserving mode)', () => {
  it('keeps every valid row, repeats included, with its own values', () => {
    const result = parseBroadcastCsvRows(
      `phone,name
+15551230000,Ada Morning
+15559990000,Grace
+15551230000,Ada Evening`
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => [r.sourceRow, r.name])).toEqual([
      [2, 'Ada Morning'],
      [3, 'Grace'],
      [4, 'Ada Evening'],
    ]);
    expect(result.review).toMatchObject({
      totalRows: 3,
      validRows: 3,
      uniqueNumbers: 2,
      repeatedRows: 1,
    });
  });

  it('collapses differently-formatted spellings of one number onto one key but keeps both rows', () => {
    const result = parseBroadcastCsvRows(
      `phone,name
+1 (555) 123-0000,Ada
+1-555-123-0000,Ada Again`
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].key).toBe(result.rows[1].key);
    expect(result.review.uniqueNumbers).toBe(1);
    expect(result.review.repeatedRows).toBe(1);
  });

  it('skips invalid numbers with reasons and counts them in the review', () => {
    const result = parseBroadcastCsvRows(
      `phone,name
4155551212,National US
+14155551212,Ada
,Nobody`
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.review.totalRows).toBe(3);
    expect(result.review.validRows).toBe(1);
    expect(result.review.skipped).toEqual([
      { phone: '4155551212', name: 'National US', sourceRow: 2, reason: 'invalid_phone' },
      { phone: '', name: 'Nobody', sourceRow: 4, reason: 'invalid_phone' },
    ]);
  });

  it('tracks physical line numbers across blank lines and embedded newlines', () => {
    const result = parseBroadcastCsvRows(
      `phone,name
+15551230000,Ada

+15559990000,"Grace\nHopper"`
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.sourceRow)).toEqual([2, 4]);
  });

  it('strips a UTF-8 BOM before the header scan', () => {
    const result = parseBroadcastCsvRows('\uFEFFphone,name\n+15551230000,Ada');
    expect(result.ok).toBe(true);
  });

  it('keeps the shared error contract for unusable files', () => {
    expect(parseBroadcastCsvRows('name,email\nAda,a@b.com')).toEqual({
      ok: false,
      error: 'missing_phone_column',
    });
    expect(parseBroadcastCsvRows('phone,name\n4155551212,Ada')).toEqual({
      ok: false,
      error: 'no_valid_rows',
    });
  });

  it('carries per-row email/company for variable resolution', () => {
    const result = parseBroadcastCsvRows(
      `phone,name,email,company
+15551230000,Ada,ada@example.com,Lovelace`
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({
      name: 'Ada',
      email: 'ada@example.com',
      company: 'Lovelace',
    });
  });
});
