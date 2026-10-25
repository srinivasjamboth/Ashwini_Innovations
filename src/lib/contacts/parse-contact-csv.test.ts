import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: true,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
        },
      ],
    });
  });

  it('keeps a row with an empty phone cell instead of dropping it silently', () => {
    const csv = `phone,name
+15551234567,Alice
,Bob`;

    const { rows } = parseContactCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      phone: '',
      name: 'Bob',
      email: undefined,
      company: undefined,
      tagNames: [],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: false,
      hasCompanyColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
        },
      ],
    });
  });

  it('accepts the Whatsapp + CountryCode sample format and composes E.164', () => {
    const csv = `Name,CountryCode,Whatsapp
Rahul Sharma,91,9876543210
Priya Patel,91,9876543211`;

    const { rows, hasPhoneColumn } = parseContactCsv(csv);
    expect(hasPhoneColumn).toBe(true);
    expect(rows.map((r) => r.phone)).toEqual(['+919876543210', '+919876543211']);
    expect(rows[0].name).toBe('Rahul Sharma');
  });

  it('leaves an already-international Whatsapp number untouched', () => {
    const csv = `Name,CountryCode,Whatsapp
Amit Kumar,91,+919876543212`;

    expect(parseContactCsv(csv).rows[0].phone).toBe('+919876543212');
  });

  it('prefers a legacy phone column when both phone and whatsapp exist', () => {
    const csv = `phone,whatsapp,countrycode
+15551234567,9999999999,91`;

    expect(parseContactCsv(csv).rows[0].phone).toBe('+15551234567');
  });

  it('keeps a national number with no country code so it is flagged invalid', () => {
    const csv = `Name,Whatsapp
Rahul,9876543210`;

    expect(parseContactCsv(csv).rows[0].phone).toBe('9876543210');
  });

  it('reports no phone column when neither phone nor whatsapp is present', () => {
    const csv = `name,email
Alice,a@b.com`;

    const result = parseContactCsv(csv);
    expect(result.hasPhoneColumn).toBe(false);
    expect(result.rows).toEqual([]);
  });
});
