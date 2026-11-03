'use client';

// ============================================================
// FilterConditionsBuilder — the Field / Condition / Value row
// editor behind "Add by filter" (spec PART 4). It is a thin UI
// over the ONE filter model (src/lib/contacts/contact-filter.ts):
// rows compile to {field, op, value} conditions that the shared
// matched_contact_ids RPC evaluates server-side. No SQL is ever
// assembled from these values.
//
// The builder keeps the free-text search separate (a `search`
// string handled by the parent panel), exactly like the contacts
// list does.
// ============================================================

import { useTranslations } from 'next-intl';
import {
  DATE_FIELD,
  GROUP_FIELD,
  TAG_FIELD,
  TEXT_FIELDS,
  betweenValue,
  opsForField,
  sanitizeCondition,
  splitBetween,
  type ContactFilterCondition,
  type FilterOp,
} from '@/lib/contacts/contact-filter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Trash2 } from 'lucide-react';

/** A builder row. `from`/`to` are only used by the date-range op;
 *  everything else lives in `value` (text, or a tag/group id). */
export interface FilterRow {
  key: string;
  field: string;
  op: FilterOp;
  value: string;
  from: string;
  to: string;
}

let rowCounter = 0;

export function newFilterRow(field = 'name'): FilterRow {
  rowCounter += 1;
  return {
    key: `row-${rowCounter}`,
    field,
    op: opsForField(field)[0],
    value: '',
    from: '',
    to: '',
  };
}

/** Row → sanitized condition. Incomplete / invalid rows drop out, so
 *  the live preview keeps working while a row is half-typed. */
export function rowToCondition(row: FilterRow): ContactFilterCondition | null {
  const value =
    row.field === DATE_FIELD && row.op === 'between'
      ? betweenValue(row.from, row.to)
      : row.value;
  return sanitizeCondition({ field: row.field, op: row.op, value });
}

export function rowsToConditions(rows: FilterRow[]): ContactFilterCondition[] {
  const out: ContactFilterCondition[] = [];
  for (const row of rows) {
    const c = rowToCondition(row);
    if (c) out.push(c);
  }
  return out;
}

/** Id-list ops stay machine-generated (the Contacts tab's legacy
 *  "all matching" path); the human builder only offers the simple
 *  comparisons the spec names. */
function visibleOps(field: string): FilterOp[] {
  return opsForField(field).filter((op) => op !== 'in' && op !== 'nin');
}

export interface FilterConditionsBuilderProps {
  rows: FilterRow[];
  onRowsChange: (rows: FilterRow[]) => void;
  tags: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  customFields: { id: string; field_name: string }[];
}

export function FilterConditionsBuilder({
  rows,
  onRowsChange,
  tags,
  groups,
  customFields,
}: FilterConditionsBuilderProps) {
  const t = useTranslations('Contacts.groups.addByFilter');

  function updateRow(key: string, patch: Partial<FilterRow>) {
    onRowsChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  /** Switching field resets the op (each field family has its own) and
   *  every value, so no stale id/date ever reaches the RPC. */
  function switchField(key: string, field: string) {
    onRowsChange(
      rows.map((r) =>
        r.key === key
          ? {
              ...r,
              field,
              op: opsForField(field)[0],
              value: '',
              from: '',
              to: '',
            }
          : r
      )
    );
  }

  function removeRow(key: string) {
    onRowsChange(rows.filter((r) => r.key !== key));
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const needsValue = row.op !== 'empty' && row.op !== 'not_empty';
        const isDateBetween = row.field === DATE_FIELD && row.op === 'between';
        return (
          <div
            key={row.key}
            className="border-border bg-muted/30 flex flex-wrap items-center gap-2 rounded-lg border p-2"
          >
            {/* ── Field ── */}
            <Select
              value={row.field}
              onValueChange={(v) => v && switchField(row.key, v)}
            >
              <SelectTrigger className="bg-background border-border text-foreground w-full grow sm:w-[calc(33%-0.5rem)]">
                <SelectValue>{t(fieldLabelKey(row.field))}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {/* Base UI requires every GroupLabel inside a Group. */}
                <SelectGroup>
                  <SelectLabel className="text-muted-foreground text-xs">
                    {t('groupContact')}
                  </SelectLabel>
                  {TEXT_FIELDS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {t(`field.${f}`)}
                    </SelectItem>
                  ))}
                  <SelectItem value={TAG_FIELD}>{t('field.tag')}</SelectItem>
                  <SelectItem value={GROUP_FIELD}>
                    {t('field.group')}
                  </SelectItem>
                  <SelectItem value={DATE_FIELD}>
                    {t('field.created_at')}
                  </SelectItem>
                </SelectGroup>
                {customFields.length > 0 && (
                  <SelectGroup>
                    <SelectLabel className="text-muted-foreground text-xs">
                      {t('groupCustom')}
                    </SelectLabel>
                    {customFields.map((cf) => (
                      <SelectItem key={cf.id} value={`custom:${cf.id}`}>
                        {cf.field_name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>

            {/* ── Condition ── */}
            <Select
              value={row.op}
              onValueChange={(v) =>
                v && updateRow(row.key, { op: v as FilterOp })
              }
            >
              <SelectTrigger className="bg-background border-border text-foreground w-full grow sm:w-[calc(25%-0.5rem)]">
                <SelectValue>{t(`op.${row.op}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {visibleOps(row.field).map((op) => (
                  <SelectItem key={op} value={op}>
                    {t(`op.${op}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* ── Value ── */}
            {needsValue && (
              <div className="flex min-w-0 grow items-center gap-1.5 sm:basis-[calc(42%-1rem)]">
                {row.field === TAG_FIELD ? (
                  <ValueSelect
                    placeholder={t('pickTag')}
                    value={row.value}
                    onChange={(v) => updateRow(row.key, { value: v })}
                    options={tags.map((tag) => ({
                      value: tag.id,
                      label: tag.name,
                    }))}
                    emptyLabel={t('noTags')}
                  />
                ) : row.field === GROUP_FIELD ? (
                  <ValueSelect
                    placeholder={t('pickGroup')}
                    value={row.value}
                    onChange={(v) => updateRow(row.key, { value: v })}
                    options={groups.map((g) => ({
                      value: g.id,
                      label: g.name,
                    }))}
                    emptyLabel={t('noGroups')}
                  />
                ) : isDateBetween ? (
                  <>
                    <Input
                      type="date"
                      aria-label={t('dateFrom')}
                      value={row.from}
                      onChange={(e) =>
                        updateRow(row.key, { from: e.target.value })
                      }
                      className="bg-background border-border text-foreground"
                    />
                    <span className="text-muted-foreground text-xs">–</span>
                    <Input
                      type="date"
                      aria-label={t('dateTo')}
                      value={row.to}
                      onChange={(e) =>
                        updateRow(row.key, { to: e.target.value })
                      }
                      className="bg-background border-border text-foreground"
                    />
                  </>
                ) : row.field === DATE_FIELD ? (
                  <Input
                    type="date"
                    value={row.value}
                    onChange={(e) =>
                      updateRow(row.key, { value: e.target.value })
                    }
                    className="bg-background border-border text-foreground"
                  />
                ) : (
                  <Input
                    value={row.value}
                    onChange={(e) =>
                      updateRow(row.key, { value: e.target.value })
                    }
                    placeholder={t('valuePlaceholder')}
                    maxLength={200}
                    className="bg-background border-border text-foreground placeholder:text-muted-foreground"
                  />
                )}
              </div>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => removeRow(row.key)}
              className="text-muted-foreground ml-auto hover:text-red-400"
              aria-label={t('removeCondition')}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      })}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onRowsChange([...rows, newFilterRow()])}
          disabled={rows.length >= 12}
          className="border-border text-muted-foreground hover:bg-muted"
        >
          <Plus className="size-3.5" />
          {t('addCondition')}
        </Button>
        {rows.length > 1 && (
          <p className="text-muted-foreground text-xs">{t('andNote')}</p>
        )}
      </div>
    </div>
  );
}

/** Shared tag/group picker for the value slot. */
function ValueSelect({
  placeholder,
  value,
  onChange,
  options,
  emptyLabel,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  emptyLabel: string;
}) {
  const [current] = options.filter((o) => o.value === value);
  return (
    <Select value={value || undefined} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger className="bg-background border-border text-foreground w-full">
        <SelectValue>
          {current?.label ?? (options.length === 0 ? emptyLabel : placeholder)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Field label key for the select header (custom rows show the field
 *  name itself inside the list; the trigger needs a stable label). */
function fieldLabelKey(field: string): string {
  if (field.startsWith('custom:')) return 'field.custom';
  return `field.${field}`;
}

/* Re-exported so the panel can restore a between-range into two date
   inputs without importing the model module directly. */
export { splitBetween };
