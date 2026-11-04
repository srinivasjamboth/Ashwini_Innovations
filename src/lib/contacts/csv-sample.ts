/**
 * The canonical contact CSV template: `Name, CountryCode, Whatsapp`.
 *
 * Kept in one place so the broadcast wizard's "Download Sample CSV" (and
 * any future importer) hand out the exact layout `parseContactCsv` expects
 * — the country code split into its own column and no leading `+` on the
 * number. `parseContactCsv` recombines `CountryCode` + `Whatsapp` into the
 * international form internally, so this file is presentation only.
 */

export const CONTACT_CSV_HEADERS = ['Name', 'CountryCode', 'Whatsapp'] as const;

const SAMPLE_ROWS: string[][] = [
  ['Rahul Sharma', '91', '9876543210'],
  ['Priya Patel', '91', '9876543211'],
  ['Amit Kumar', '91', '9876543212'],
];

/** Build the sample CSV text (LF line endings, no trailing newline). */
export function buildSampleContactCsv(): string {
  return [
    CONTACT_CSV_HEADERS.join(','),
    ...SAMPLE_ROWS.map((row) => row.join(',')),
  ].join('\n');
}

/**
 * Hand the sample file to the browser as a download. Client-only —
 * same blob-and-link mechanics the broadcast wizard's step 2 uses, so
 * any page offering "Download Sample CSV" gives out the identical file.
 */
export function downloadSampleContactCsv(): void {
  const blob = new Blob([buildSampleContactCsv()], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'contacts-sample.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
