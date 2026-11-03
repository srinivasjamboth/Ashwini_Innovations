'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  parseBroadcastCsvRows,
  type BroadcastCsvRow,
} from '@/lib/broadcast-csv';
import { normalizeKey } from '@/lib/contacts/dedupe';
import { listAllGroups, resolveGroupContactIds } from '@/lib/contacts/group-api';
import { buildSampleContactCsv } from '@/lib/contacts/csv-sample';
import { usePlan } from '@/hooks/use-plan';
import { useAuth } from '@/hooks/use-auth';
import { ContactGroup, CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Users,
  Tags,
  Filter,
  Upload,
  FileText,
  Download,
  Loader2,
  ArrowRight,
  ArrowLeft,
  X,
  AlertTriangle,
  FolderClosed,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

type AudienceType = 'all' | 'tags' | 'groups' | 'custom_field' | 'csv';
type CustomFieldOperator = 'is' | 'is_not' | 'contains';

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  /** Contact-group audience — see use-broadcast-sending. */
  groupIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Duplicate-preserving CSV rows — see use-broadcast-sending. */
  csvRows?: BroadcastCsvRow[];
  csvFileName?: string;
  excludeTagIds?: string[];
}

/**
 * Whole-file review for the CSV audience. Counts are computed against
 * the real account (existing contacts, exclusion tags) so what the
 * operator sees here is exactly what the send will freeze.
 */
interface CsvReview {
  totalRows: number;
  validRows: number;
  uniqueNumbers: number;
  repeatedRows: number;
  newContacts: number;
  existingContacts: number;
  excludedRows: number;
  skipped: { phone: string; name?: string; sourceRow: number; reason: string }[];
  rowsToSend: number;
  planBlock: 'contacts' | 'bulk_messages' | null;
}

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const t = useTranslations('Broadcasts.wizard');
  const { remaining, openUpgrade } = usePlan();
  const { accountId } = useAuth();

  const OPERATOR_OPTIONS = useMemo<{ value: CustomFieldOperator; label: string }[]>(() => [
    { value: 'is', label: t('selectAudience.operatorIs') },
    { value: 'is_not', label: t('selectAudience.operatorIsNot') },
    { value: 'contains', label: t('selectAudience.operatorContains') },
  ], [t]);

  const audienceOptions = useMemo<{
    type: AudienceType;
    label: string;
    description: string;
    icon: typeof Users;
  }[]>(() => [
    {
      type: 'all',
      label: t('selectAudience.method.all'),
      description: t('selectAudience.allDescLoading'),
      icon: Users,
    },
    {
      type: 'tags',
      label: t('selectAudience.method.tags'),
      description: t('selectAudience.tagDesc'),
      icon: Tags,
    },
    {
      type: 'groups',
      label: t('selectAudience.method.groups'),
      description: t('selectAudience.groupDesc'),
      icon: FolderClosed,
    },
    {
      type: 'custom_field',
      label: t('selectAudience.method.customField'),
      description: t('selectAudience.customFieldDesc'),
      icon: Filter,
    },
    {
      type: 'csv',
      label: t('selectAudience.method.csv'),
      description: t('selectAudience.csvDesc'),
      icon: Upload,
    },
  ], [t]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [groups, setGroups] = useState<ContactGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  // The picked file's name, shown back to the user. The parsed rows
  // themselves live on `audience.csvContacts` (owned by the wizard) so
  // they survive stepping forward and back.
  const [pickedCsvName, setPickedCsvName] = useState<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  // Review computed once per uploaded file (see computeReview below).
  const [review, setReview] = useState<CsvReview | null>(null);
  // Skipped rows live here between the parse (file pick) and the
  // review; kept out of `review` so the effect never reads stale state.
  const [csvSkipped, setCsvSkipped] = useState<
    { phone: string; name?: string; sourceRow: number; reason: string }[]
  >([]);

  const csvCount = audience.csvContacts?.length ?? 0;
  // Only meaningful while the rows it produced are still in play —
  // picking another audience type wipes `csvContacts`.
  const csvFileName = csvCount > 0 ? pickedCsvName : null;

  // Tags are used both by the primary "Filter by Tags" audience type
  // AND by the exclude-list below — so always load once on mount.
  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);
      try {
        const supabase = createClient();
        const { data } = await supabase.from('tags').select('*').order('name');
        setTags(data ?? []);
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTags();
  }, []);

  // Groups back the "Send to Group(s)" audience — paged list so a
  // large account's groups all show up in the picker.
  useEffect(() => {
    async function fetchGroups() {
      setLoadingGroups(true);
      try {
        const supabase = createClient();
        setGroups(await listAllGroups(supabase));
      } catch {
        setGroups([]);
      } finally {
        setLoadingGroups(false);
      }
    }
    fetchGroups();
  }, []);

  // Lazy-load custom fields only when that audience type is active.
  useEffect(() => {
    if (audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [audience.type]);

  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      const supabase = createClient();

      // Base query — produces the superset before exclude is applied.
      let baseIds: Set<string> | null = null; // null means "all contacts"

      if (audience.type === 'all') {
        // Handled below — full-table count adjusted by excludes.
      } else if (
        audience.type === 'tags' &&
        audience.tagIds &&
        audience.tagIds.length > 0
      ) {
        const { data } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.tagIds);
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'groups' &&
        audience.groupIds &&
        audience.groupIds.length > 0
      ) {
        // ANY-group, de-duped server-side — one contact in two picked
        // groups still counts once.
        baseIds = new Set(
          await resolveGroupContactIds(supabase, audience.groupIds)
        );
      } else if (
        audience.type === 'custom_field' &&
        audience.customField?.fieldId &&
        audience.customField.value
      ) {
        const { fieldId, operator, value } = audience.customField;
        let q = supabase
          .from('contact_custom_values')
          .select('contact_id')
          .eq('custom_field_id', fieldId);
        if (operator === 'is') q = q.eq('value', value);
        else if (operator === 'is_not') q = q.neq('value', value);
        else q = q.ilike('value', `%${value}%`);
        const { data } = await q;
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'csv' &&
        audience.csvContacts &&
        audience.csvContacts.length > 0
      ) {
        // Row-mode: the promise is one message per valid ROW (repeats
        // included), so the estimate must count rows, not unique
        // contacts. minus whatever the exclusion list will drop.
        setEstimatedCount(
          (audience.csvRows?.length ?? audience.csvContacts.length) -
            (review?.excludedRows ?? 0),
        );
        return;
      } else {
        // Partially-configured audience — wait for the user to finish.
        setEstimatedCount(null);
        return;
      }

      // Apply exclude tags
      let excludeSet: Set<string> | null = null;
      if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
        const { data: excludeRows } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.excludeTagIds);
        excludeSet = new Set((excludeRows ?? []).map((r) => r.contact_id));
      }

      if (baseIds) {
        const effective = [...baseIds].filter(
          (id) => !excludeSet?.has(id),
        );
        setEstimatedCount(effective.length);
      } else {
        // "All" — fetch the total, then subtract exclude set if any.
        const { count } = await supabase
          .from('contacts')
          .select('*', { count: 'exact', head: true });
        const total = count ?? 0;
        setEstimatedCount(excludeSet ? Math.max(0, total - excludeSet.size) : total);
      }
    } finally {
      setLoadingCount(false);
    }
  }, [
    audience.type,
    audience.tagIds,
    audience.groupIds,
    audience.customField,
    audience.csvContacts,
    audience.csvRows,
    audience.excludeTagIds,
    review,
  ]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  async function handleCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    // Duplicate-PRESERVING mode: every valid row is its own recipient.
    // The Contacts page importer keeps its skip-duplicates contract;
    // only the broadcast audience sees a repeated number as a repeated
    // message.
    const result = parseBroadcastCsvRows(await selected.text());

    if (!result.ok) {
      toast.error(
        result.error === 'missing_phone_column'
          ? t('selectAudience.errorCsvMissingPhone')
          : t('selectAudience.errorCsvParse'),
      );
      // Clear the input so re-picking the same corrected file still
      // fires `change` (the browser suppresses it for an identical value).
      e.target.value = '';
      setPickedCsvName(null);
      setReview(null);
      setCsvSkipped([]);
      onUpdate({
        ...audience,
        csvContacts: undefined,
        csvRows: undefined,
        csvFileName: undefined,
      });
      return;
    }

    // Rows without a leading `+` and country code were refused (issue
    // #586). Say so, or a spreadsheet export that stripped the `+` looks
    // like a mysteriously smaller audience. The full list stays in the
    // review block with a download.
    if (result.review.skipped.length > 0) {
      toast.warning(
        t('selectAudience.csvInvalidPhones', { count: result.review.skipped.length }),
      );
    }

    setPickedCsvName(selected.name);
    setCsvSkipped(result.review.skipped);
    onUpdate({
      ...audience,
      // Legacy shape kept for Step1's preview wiring.
      csvContacts: result.rows.map(({ phone, name }) =>
        name ? { phone, name } : { phone }
      ),
      csvRows: result.rows,
      csvFileName: selected.name,
    });
  }

  /**
   * Whole-file review: match every row number against the account's
   * contacts and the exclusion tags, then run the plan pre-check for
   * the WHOLE batch (new unique numbers vs the contact limit, rows to
   * send vs the bulk quota). Runs when a file is picked or the
   * exclusion list changes — the upsert the send path performs later
   * is the same idempotent contact resolution, keyed on the number.
   */
  async function computeReview(
    rows: BroadcastCsvRow[],
    skipped: { phone: string; name?: string; sourceRow: number; reason: string }[],
    excludeTagIds: string[],
  ) {
    const supabase = createClient();
    const keys = [...new Set(rows.map((r) => r.key))];

    const existingKeys = new Set<string>();
    const LOOKUP_CHUNK = 500; // PostgREST .in(...) bound
    for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
      const { data } = await supabase
        .from('contacts')
        .select('phone')
        .in('phone_normalized', keys.slice(i, i + LOOKUP_CHUNK));
      for (const c of data ?? []) {
        const k = normalizeKey((c as { phone: string }).phone ?? '');
        if (k) existingKeys.add(k);
      }
    }

    // How many ROWS the exclusion list will drop: excluded contact ids
    // mapped back onto normalized numbers, then counted per row.
    let excludedRows = 0;
    if (excludeTagIds.length > 0) {
      const { data: tagRows } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', excludeTagIds);
      const excludedContactIds = [...new Set((tagRows ?? []).map((r) => r.contact_id))];
      if (excludedContactIds.length > 0) {
        const excludedKeys = new Set<string>();
        const ID_CHUNK = 500;
        for (let i = 0; i < excludedContactIds.length; i += ID_CHUNK) {
          const { data } = await supabase
            .from('contacts')
            .select('phone')
            .in('id', excludedContactIds.slice(i, i + ID_CHUNK));
          for (const c of data ?? []) {
            const k = normalizeKey((c as { phone: string }).phone ?? '');
            if (k) excludedKeys.add(k);
          }
        }
        excludedRows = rows.filter((r) => excludedKeys.has(r.key)).length;
      }
    }

    const uniqueNumbers = keys.length;
    const existingNumbers = keys.filter((k) => existingKeys.has(k)).length;
    const newContacts = uniqueNumbers - existingNumbers;
    const rowsToSend = rows.length - excludedRows;

    // Plan pre-check (whole batch, before anything is sent): the
    // contact limit counts only NEW unique numbers; the bulk quota
    // counts every row, repeats included — each is a real message.
    let planBlock: CsvReview['planBlock'] = null;
    if (newContacts > remaining('contacts')) planBlock = 'contacts';
    else if (rowsToSend > remaining('bulk_messages')) planBlock = 'bulk_messages';

    setReview({
      totalRows: rows.length + skipped.length,
      validRows: rows.length,
      uniqueNumbers,
      repeatedRows: Math.max(0, rows.length - uniqueNumbers),
      newContacts,
      existingContacts: existingNumbers,
      excludedRows,
      skipped,
      rowsToSend,
      planBlock,
    });
  }

  // (Re)compute the review whenever the rows or the exclusion list
  // change. All setStates land after awaits — no sync-in-effect.
  const excludeKey = (audience.excludeTagIds ?? []).join(',');
  useEffect(() => {
    if (audience.type !== 'csv' || !audience.csvRows || audience.csvRows.length === 0) {
      setReview(null);
      return;
    }
    if (!accountId) return; // RLS-scoped lookups need an account context
    void computeReview(audience.csvRows, csvSkipped, audience.excludeTagIds ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, audience.type, audience.csvRows, csvSkipped, excludeKey]);

  // Hand the user a ready-to-fill template matching the format the parser
  // expects (Name, CountryCode, Whatsapp — no `+`, country code split out).
  function downloadSampleCsv() {
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

  // Review rows carry their file line numbers, so the skipped list
  // downloads exactly as the spreadsheet exported it — row number first
  // — and the corrected file re-picks cleanly.
  function downloadSkippedCsv() {
    if (!review || review.skipped.length === 0) return;
    const csvRows = [
      ['row', 'phone', 'name', 'reason'],
      ...review.skipped.map((s) => [
        String(s.sourceRow),
        s.phone,
        s.name ?? '',
        s.reason,
      ]),
    ];
    const blob = new Blob([csvRows.map((r) => r.join(',')).join('\r\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'skipped-rows.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, tagIds: updated });
  }

  function toggleGroup(groupId: string) {
    const current = audience.groupIds ?? [];
    const updated = current.includes(groupId)
      ? current.filter((id) => id !== groupId)
      : [...current, groupId];
    onUpdate({ ...audience, groupIds: updated });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, excludeTagIds: updated });
  }

  function updateCustomField(patch: Partial<CustomFieldFilter>) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };
    onUpdate({ ...audience, customField: { ...prev, ...patch } });
  }

  // A CSV audience isn't ready until its whole-file review is done and
  // inside the plan's limits — "Next" blocks exactly what the send
  // would have to refuse later.
  const csvReady =
    audience.type !== 'csv' ||
    (!!review && review.planBlock === null && review.rowsToSend > 0);

  // A groups audience with no resolvable members (all picked groups are
  // empty, or every member lands on an exclude tag) sends nothing —
  // block "Next" here instead of failing at send time.
  const groupsEmpty =
    audience.type === 'groups' &&
    !!audience.groupIds &&
    audience.groupIds.length > 0 &&
    !loadingCount &&
    estimatedCount === 0;

  const isValid =
    csvReady &&
    (audience.type === 'all' ||
      (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
      (audience.type === 'groups' &&
        audience.groupIds &&
        audience.groupIds.length > 0 &&
        !groupsEmpty) ||
      (audience.type === 'custom_field' &&
        !!audience.customField?.fieldId &&
        audience.customField.value.length > 0) ||
      (audience.type === 'csv' &&
        audience.csvContacts &&
        audience.csvContacts.length > 0));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('selectAudience.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('selectAudience.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {audienceOptions.map((option: { type: AudienceType; label: string; description: string; icon: typeof Users }) => {
          const isSelected = audience.type === option.type;
          const Icon = option.icon;
          return (
            <button
              key={option.type}
              onClick={() =>
                onUpdate({
                  ...audience,
                  type: option.type,
                  // Wipe shape fields from other types to avoid stale
                  // config leaking across selections.
                  tagIds: option.type === 'tags' ? audience.tagIds : undefined,
                  groupIds:
                    option.type === 'groups' ? audience.groupIds : undefined,
                  customField:
                    option.type === 'custom_field'
                      ? audience.customField
                      : undefined,
                  csvContacts:
                    option.type === 'csv' ? audience.csvContacts : undefined,
                  csvRows:
                    option.type === 'csv' ? audience.csvRows : undefined,
                  csvFileName:
                    option.type === 'csv' ? audience.csvFileName : undefined,
                })
              }
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                isSelected
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                  : 'border-border bg-card/50 hover:border-border'
              }`}
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  isSelected
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{option.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {option.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {audience.type === 'tags' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <p className="mb-3 text-sm font-medium text-foreground">{t('selectAudience.selectTags')}</p>
          {loadingTags ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.noTagsFound')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = audience.tagIds?.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                      isSelected
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground hover:border-border'
                    }`}
                  >
                    <span
                      className="mr-1.5 h-2 w-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {audience.type === 'groups' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <p className="mb-3 text-sm font-medium text-foreground">{t('selectAudience.selectGroups')}</p>
          {loadingGroups ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : groups.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.noGroupsFound')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {groups.map((group) => {
                const isSelected = audience.groupIds?.includes(group.id);
                return (
                  <button
                    key={group.id}
                    onClick={() => toggleGroup(group.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                      isSelected
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground hover:border-border'
                    }`}
                  >
                    <FolderClosed className="h-3 w-3" />
                    {group.name}
                    <span className="tabular-nums opacity-70">
                      ({(group.member_count ?? 0).toLocaleString()})
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {groupsEmpty && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <p className="text-xs text-amber-300">
                {t('selectAudience.groupsEmptyWarning')}
              </p>
            </div>
          )}
        </div>
      )}

      {audience.type === 'custom_field' && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <p className="text-sm font-medium text-foreground">{t('selectAudience.method.customField')}</p>
          {loadingFields ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : customFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.errorLoadFields')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                value={audience.customField?.fieldId ?? ''}
                onChange={(e) => updateCustomField({ fieldId: e.target.value })}
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">{t('selectAudience.selectField')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                value={audience.customField?.operator ?? 'is'}
                onChange={(e) =>
                  updateCustomField({
                    operator: e.target.value as CustomFieldOperator,
                  })
                }
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                {OPERATOR_OPTIONS.map((op: { value: CustomFieldOperator; label: string }) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={audience.customField?.value ?? ''}
                onChange={(e) => updateCustomField({ value: e.target.value })}
                placeholder={t('selectAudience.valuePlaceholder')}
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
        </div>
      )}

      {audience.type === 'csv' && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">
              {t('selectAudience.uploadCsv')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('selectAudience.csvFormatDesc')}
            </p>
          </div>

          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            className="group flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-4 py-6 text-center transition-colors hover:border-primary/40 hover:bg-muted/70"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:text-foreground">
              {csvFileName ? (
                <FileText className="h-5 w-5" />
              ) : (
                <Upload className="h-5 w-5" />
              )}
            </div>
            <p className="text-sm text-foreground">
              {csvFileName ?? t('selectAudience.uploadCsv')}
            </p>
            {csvCount > 0 && (
              <p className="text-xs text-primary">
                {t('selectAudience.csvContactsFound', { count: csvCount })}
              </p>
            )}
          </button>

          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvChange}
            className="hidden"
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={downloadSampleCsv}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <Download className="h-3.5 w-3.5" />
              {t('selectAudience.downloadSampleCsv')}
            </button>
          </div>

          {/* Whole-file review — every valid row sends, repeats included. */}
          {audience.csvRows && audience.csvRows.length > 0 && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              {review ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
                  <p className="text-muted-foreground">
                    {t('selectAudience.csvReviewTotal')}
                    <span className="ml-1 font-medium text-foreground">
                      {review.totalRows.toLocaleString()}
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    {t('selectAudience.csvReviewValid')}
                    <span className="ml-1 font-medium text-foreground">
                      {review.validRows.toLocaleString()}
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    {t('selectAudience.csvReviewUnique')}
                    <span className="ml-1 font-medium text-foreground">
                      {review.uniqueNumbers.toLocaleString()}
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    {t('selectAudience.csvReviewRepeated')}
                    <span className="ml-1 font-medium text-foreground">
                      {review.repeatedRows.toLocaleString()}
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    {t('selectAudience.csvReviewNewContacts')}
                    <span className="ml-1 font-medium text-foreground">
                      {review.newContacts.toLocaleString()}
                    </span>
                  </p>
                  <p className="text-muted-foreground">
                    {t('selectAudience.csvReviewExistingContacts')}
                    <span className="ml-1 font-medium text-foreground">
                      {review.existingContacts.toLocaleString()}
                    </span>
                  </p>
                  {review.excludedRows > 0 && (
                    <p className="text-muted-foreground">
                      {t('selectAudience.csvReviewExcluded')}
                      <span className="ml-1 font-medium text-red-400">
                        {review.excludedRows.toLocaleString()}
                      </span>
                    </p>
                  )}
                  <p className="text-muted-foreground">
                    {t('selectAudience.csvReviewSkipped')}
                    <span className="ml-1 font-medium text-foreground">
                      {review.skipped.length.toLocaleString()}
                    </span>
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-xs text-muted-foreground">
                    {t('selectAudience.csvReviewCalculating')}
                  </span>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {t('selectAudience.csvReviewEveryRow')}
              </p>

              {review && review.skipped.length > 0 && (
                <button
                  type="button"
                  onClick={downloadSkippedCsv}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t('selectAudience.csvReviewDownloadSkipped')}
                </button>
              )}

              {review?.planBlock && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <div className="space-y-2">
                    <p className="text-xs text-red-300">
                      {t('selectAudience.csvReviewPlanBlock', {
                        count:
                          review.planBlock === 'contacts'
                            ? review.newContacts
                            : review.rowsToSend,
                        remaining: remaining(review.planBlock),
                      })}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        openUpgrade({ intent: 'upgrade', feature: review.planBlock ?? undefined })
                      }
                    >
                      {t('selectAudience.csvReviewUpgrade')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Exclude list — applies regardless of audience type */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <X className="h-4 w-4 text-red-400" />
          <p className="text-sm font-medium text-foreground">
            {t('selectAudience.excludeTags')}
          </p>
        </div>
        {tags.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('selectAudience.noTagsFound')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isExcluded = audience.excludeTagIds?.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleExcludeTag(tag.id)}
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                    isExcluded
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-border bg-muted text-muted-foreground hover:border-border'
                  }`}
                >
                  <span
                    className="mr-1.5 h-2 w-2 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Audience Summary */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="mb-2 text-sm font-medium text-foreground">{t('selectAudience.audienceSummary')}</p>
        {loadingCount ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">{t('selectAudience.calculating')}</span>
          </div>
        ) : estimatedCount !== null ? (
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <span className="text-sm text-foreground">
              {estimatedCount.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">estimated recipients</span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Select an audience type to see the estimate.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!isValid}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
