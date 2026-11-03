import { describe, expect, it } from 'vitest';
import {
  betweenValue,
  hasActiveFilter,
  legacyFilterToConditions,
  opsForField,
  sanitizeCondition,
  sanitizeConditions,
  splitBetween,
  MAX_CONDITIONS,
} from './contact-filter';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('sanitizeCondition', () => {
  it('accepts a text-field row', () => {
    expect(sanitizeCondition({ field: 'name', op: 'contains', value: ' acme ' })).toEqual({
      field: 'name',
      op: 'contains',
      value: 'acme',
    });
  });

  it('accepts a custom-field row keyed by custom:<id>', () => {
    const c = sanitizeCondition({
      field: `custom:${UUID_A}`,
      op: 'eq',
      value: 'RMI001',
    });
    expect(c).not.toBeNull();
    expect(c!.field).toBe(`custom:${UUID_A}`);
  });

  it('rejects unknown fields, ops for the wrong field, and non-objects', () => {
    expect(sanitizeCondition({ field: 'salary', op: 'eq', value: '1' })).toBeNull();
    expect(sanitizeCondition({ field: 'created_at', op: 'contains', value: 'x' })).toBeNull();
    expect(sanitizeCondition({ field: 'tag', op: 'between', value: 'a,b' })).toBeNull();
    expect(sanitizeCondition(null)).toBeNull();
    expect(sanitizeCondition('nope')).toBeNull();
  });

  it('requires uuid values on tag/group rows', () => {
    expect(sanitizeCondition({ field: 'tag', op: 'eq', value: UUID_A })).not.toBeNull();
    expect(sanitizeCondition({ field: 'tag', op: 'eq', value: 'VIP' })).toBeNull();
    expect(sanitizeCondition({ field: 'group', op: 'in', value: `${UUID_A},${UUID_B}` })).not.toBeNull();
    expect(sanitizeCondition({ field: 'group', op: 'in', value: `${UUID_A},not-a-uuid` })).toBeNull();
  });

  it('validates date rows, including an ordered between pair', () => {
    expect(sanitizeCondition({ field: 'created_at', op: 'eq', value: '2026-01-31' })).not.toBeNull();
    expect(sanitizeCondition({ field: 'created_at', op: 'eq', value: '31/01/2026' })).toBeNull();
    expect(
      sanitizeCondition({ field: 'created_at', op: 'between', value: betweenValue('2026-01-01', '2026-02-01') })
    ).not.toBeNull();
    // Inverted or malformed ranges never leave the builder.
    expect(sanitizeCondition({ field: 'created_at', op: 'between', value: '2026-02-01,2026-01-01' })).toBeNull();
    expect(sanitizeCondition({ field: 'created_at', op: 'between', value: '2026-01-01' })).toBeNull();
  });

  it('carries no value for the empty ops', () => {
    expect(sanitizeCondition({ field: 'email', op: 'empty', value: 'junk' })).toEqual({
      field: 'email',
      op: 'empty',
      value: '',
    });
  });

  it('caps oversized text values', () => {
    expect(sanitizeCondition({ field: 'name', op: 'contains', value: 'x'.repeat(201) })).toBeNull();
  });
});

describe('sanitizeConditions', () => {
  it('drops invalid rows and caps the list length', () => {
    const raw = [
      { field: 'name', op: 'contains', value: 'a' },
      { field: 'evil', op: 'eq', value: 'b' },
      ...Array.from({ length: MAX_CONDITIONS }, () => ({
        field: 'phone',
        op: 'starts',
        value: '+91',
      })),
    ];
    const out = sanitizeConditions(raw);
    expect(out).toHaveLength(MAX_CONDITIONS);
    expect(out.every((c) => c.field !== 'evil')).toBe(true);
  });

  it('returns [] for non-array input', () => {
    expect(sanitizeConditions(undefined)).toEqual([]);
    expect(sanitizeConditions({ field: 'name' })).toEqual([]);
  });
});

describe('opsForField', () => {
  it('gives id fields set ops, date fields range ops, text fields the text set', () => {
    expect(opsForField('tag')).toEqual(['eq', 'neq', 'in', 'nin']);
    expect(opsForField('created_at')).toEqual(['eq', 'between']);
    expect(opsForField('company')).toContain('contains');
    expect(opsForField(`custom:${UUID_A}`)).toContain('starts');
  });
});

describe('legacyFilterToConditions', () => {
  it('maps the contacts-page tag/group dimensions to in-rows', () => {
    expect(legacyFilterToConditions({ tagIds: [UUID_A, UUID_B], groupIds: [UUID_A] })).toEqual([
      { field: 'tag', op: 'in', value: `${UUID_A},${UUID_B}` },
      { field: 'group', op: 'in', value: UUID_A },
    ]);
  });

  it('skips empty and malformed dimensions', () => {
    expect(legacyFilterToConditions({ tagIds: [], groupIds: ['oops'] })).toEqual([]);
    expect(legacyFilterToConditions({})).toEqual([]);
  });
});

describe('between helpers', () => {
  it('round-trips a range pair', () => {
    const value = betweenValue(' 2026-01-01 ', '2026-03-15');
    expect(value).toBe('2026-01-01,2026-03-15');
    expect(splitBetween(value)).toEqual(['2026-01-01', '2026-03-15']);
  });
});

describe('hasActiveFilter', () => {
  it('treats whitespace-only search as no filter', () => {
    expect(hasActiveFilter([], '   ')).toBe(false);
    expect(hasActiveFilter([], 'vip')).toBe(true);
  });
});
