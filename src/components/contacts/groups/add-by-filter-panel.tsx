'use client';

// ============================================================
// AddByFilterPanel — "Add members by filter" (spec PART 4),
// rendered with the shared Dialog (the project's SidePanel
// convention). Builder rows compile through the ONE contact-filter
// model; the live preview and the add itself run server-side via
// migration 060 RPCs, so the matching set spans every page and
// tens of thousands of contacts.
//
//   ≤ BACKGROUND_ADD_THRESHOLD → one-shot insert-from-select
//   > threshold                → resumable chunked job (a refresh
//                                mid-run is picked up by the group
//                                page via get_active_group_add_job)
//
// Everything is idempotent: ON CONFLICT DO NOTHING means re-adding
// an existing member is a no-op, never a duplicate.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { Contact } from '@/types';
import {
  BACKGROUND_ADD_THRESHOLD,
  addGroupMembersFiltered,
  listAllGroups,
  matchContacts,
  previewGroupAdd,
  runGroupAddJobChunk,
  startGroupAddJob,
} from '@/lib/contacts/group-api';
import {
  FilterConditionsBuilder,
  newFilterRow,
  rowsToConditions,
  type FilterRow,
} from '@/components/contacts/groups/filter-conditions-builder';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, Search, SlidersHorizontal } from 'lucide-react';

/** Preview settles this long after the last keystroke/row change. */
const PREVIEW_DEBOUNCE_MS = 400;

interface PreviewState {
  matchCount: number;
  alreadyCount: number;
  newCount: number;
}

export interface AddByFilterPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  groupName: string;
  /** After a successful add (either path) so members + counts refresh. */
  onAdded: () => void;
}

export function AddByFilterPanel({
  open,
  onOpenChange,
  groupId,
  groupName,
  onAdded,
}: AddByFilterPanelProps) {
  const t = useTranslations('Contacts.groups.addByFilter');
  const supabase = createClient();

  const [rows, setRows] = useState<FilterRow[]>(() => [newFilterRow()]);
  const [search, setSearch] = useState('');
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [customFields, setCustomFields] = useState<
    { id: string; field_name: string }[]
  >([]);

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [sample, setSample] = useState<Contact[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  /** Unticked preview rows — sent to the server as `p_excluded`. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ added: number; target: number } | null>(
    null
  );

  // Fresh start each time the panel opens.
  useEffect(() => {
    if (!open) return;
    setRows([newFilterRow()]);
    setSearch('');
    setPreview(null);
    setSample([]);
    setExcluded(new Set());
    setBusy(false);
    setProgress(null);
  }, [open]);

  // Picker data — same RLS-scoped reads the rest of the app uses.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [tagsRes, cfRes, groupRows] = await Promise.all([
          supabase.from('tags').select('id, name').order('name'),
          supabase.from('custom_fields').select('id, field_name').order('field_name'),
          listAllGroups(supabase),
        ]);
        if (cancelled) return;
        setTags((tagsRes.data ?? []) as { id: string; name: string }[]);
        setCustomFields(
          (cfRes.data ?? []) as { id: string; field_name: string }[]
        );
        setGroups(groupRows.map((g) => ({ id: g.id, name: g.name })));
      } catch {
        /* pickers just stay empty; preview/labels still work */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  const conditions = rowsToConditions(rows);
  const hasFilter = conditions.length > 0 || search.trim().length > 0;

  // Debounced live preview — counts + first five matches in one pass.
  const previewSeq = useRef(0);
  useEffect(() => {
    if (!open) return;
    if (!hasFilter) {
      setPreview(null);
      setSample([]);
      setPreviewLoading(false);
      return;
    }
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    const timer = setTimeout(async () => {
      const input = { conditions, search: search.trim() || undefined };
      try {
        const [counts, matches] = await Promise.all([
          previewGroupAdd(supabase, groupId, input),
          matchContacts(supabase, input, { limit: 5 }),
        ]);
        if (seq !== previewSeq.current) return;
        setPreview(counts);
        setSample(matches.contacts);
      } catch {
        if (seq !== previewSeq.current) return;
        setPreview(null);
        setSample([]);
        toast.error(t('toastPreviewFailed'));
      } finally {
        if (seq === previewSeq.current) setPreviewLoading(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groupId, search, JSON.stringify(rows), supabase, t]);

  function toggleExcluded(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Shown K: preview new count minus the unticked rows (clamped —
   *  the server is still the source of truth for the result toast). */
  const willAdd = preview
    ? Math.max(0, preview.newCount - excluded.size)
    : 0;

  const runAdd = useCallback(async () => {
    if (!preview || busy) return;
    setBusy(true);
    setConfirmOpen(false);
    setProgress(null);
    const input = { conditions, search: search.trim() || undefined };
    const excludedIds = [...excluded];
    try {
      let added: number;
      if (preview.newCount <= BACKGROUND_ADD_THRESHOLD) {
        added = await addGroupMembersFiltered(supabase, groupId, input, excludedIds);
      } else {
        // Big run: snapshot server-side, then pull chunks. If this
        // tab is closed/refreshed, the group page resumes the job.
        const jobId = await startGroupAddJob(supabase, groupId, input, excludedIds);
        let acc = 0;
        for (;;) {
          const res = await runGroupAddJobChunk(supabase, jobId);
          acc += res.added;
          setProgress({ added: acc, target: acc + res.remaining });
          if (res.status === 'done') break;
        }
        added = acc;
      }
      toast.success(t('toastResult', { added, already: preview.alreadyCount }));
      onAdded();
      onOpenChange(false);
    } catch {
      toast.error(t('toastFailed'));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, groupId, preview, excluded, search, JSON.stringify(rows), busy, onAdded, onOpenChange, t]);

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <SlidersHorizontal className="size-4 text-primary" />
              {t('title')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('desc', { group: groupName })}
            </DialogDescription>
          </DialogHeader>

          {/* Text search — kept alongside the builder rows (spec) */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="pl-8 bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <FilterConditionsBuilder
            rows={rows}
            onRowsChange={setRows}
            tags={tags}
            groups={groups}
            customFields={customFields}
          />

          {/* Live preview */}
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            {!hasFilter ? (
              <p className="text-sm text-muted-foreground">{t('promptFilter')}</p>
            ) : previewLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t('checking')}
              </p>
            ) : preview ? (
              <>
                <p className="text-sm text-foreground" role="status" aria-live="polite">
                  {t('previewCounts', {
                    match: preview.matchCount.toLocaleString(),
                    already: preview.alreadyCount.toLocaleString(),
                    willAdd: willAdd.toLocaleString(),
                  })}
                </p>

                {/* Universal select-all default + per-contact untick */}
                <div className="flex items-center gap-2">
                  <Checkbox checked disabled aria-label={t('selectAllMatching', { count: preview.matchCount })} />
                  <Label className="text-sm font-normal text-muted-foreground cursor-default">
                    {t('selectAllMatching', { count: preview.matchCount.toLocaleString() })}
                  </Label>
                </div>

                {sample.length > 0 ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t('firstMatches')}
                    </p>
                    {sample.map((c) => (
                      <label
                        key={c.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/60"
                      >
                        <Checkbox
                          checked={!excluded.has(c.id)}
                          onCheckedChange={() => toggleExcluded(c.id)}
                          disabled={busy}
                        />
                        <span className="text-foreground">
                          {c.name || t('unnamed')}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {c.phone}
                        </span>
                      </label>
                    ))}
                    <p className="text-xs text-muted-foreground">{t('untickHint')}</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('noMatches')}</p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('promptFilter')}</p>
            )}

            {busy && progress && (
              <div className="space-y-1">
                <div
                  className="h-1.5 w-full overflow-hidden rounded bg-border"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.target}
                  aria-valuenow={progress.added}
                >
                  <div
                    className="h-full rounded bg-primary transition-[width] duration-200"
                    style={{
                      width: `${progress.target > 0 ? Math.min(100, (progress.added / progress.target) * 100) : 0}%`,
                    }}
                  />
                </div>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {t('adding', {
                    added: progress.added.toLocaleString(),
                    target: progress.target.toLocaleString(),
                  })}
                </p>
              </div>
            )}
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              disabled={busy || !preview || willAdd === 0}
              onClick={() => setConfirmOpen(true)}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('addBtn', {
                count: willAdd.toLocaleString(),
                group: groupName,
              })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Count confirmation before the run starts */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('confirmTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('confirmDesc', {
                count: willAdd.toLocaleString(),
                group: groupName,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button onClick={runAdd} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {t('confirmBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
