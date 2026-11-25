'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { ContactGroup } from '@/types';
import {
  GroupNameConflictError,
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
  createGroup,
  updateGroup,
} from '@/lib/contacts/group-api';
import {
  GROUP_COLORS,
  folderToneVars,
  resolveGroupColor,
  type GroupColorKey,
} from '@/lib/contacts/group-colors';
import { FolderPreview } from '@/components/contacts/groups/group-folder-tile';
import { downloadSampleContactCsv } from '@/lib/contacts/csv-sample';
import {
  downloadInvalidRowsCsv,
} from '@/components/contacts/groups/group-csv-import-panel';
import type { GroupCsvImportResult } from '@/lib/contacts/group-csv-import';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Upload,
} from 'lucide-react';

interface GroupFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present = rename/edit; null = create. */
  group?: ContactGroup | null;
  onSaved?: (group: ContactGroup) => void;
}

/** Create / rename dialog (the "SidePanel" of the groups spec, rendered
 *  with the shared Dialog — the tremor library has no side panel). */
export function GroupFormDialog({
  open,
  onOpenChange,
  group,
  onSaved,
}: GroupFormDialogProps) {
  const t = useTranslations('Contacts.groups.form');
  const supabase = createClient();
  const { accountId } = useAuth();
  const isEdit = !!group;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<GroupColorKey>('sea');
  const [saving, setSaving] = useState(false);

  // Create-from-CSV mode (only available when creating a new group)
  const [mode, setMode] = useState<'empty' | 'from-csv'>('empty');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState('');
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvResult, setCsvResult] = useState<(GroupCsvImportResult & { group?: ContactGroup }) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(group?.name ?? '');
      setDescription(group?.description ?? '');
      // Existing groups show their stored shade — or the same
      // deterministic default the grid renders when color is NULL.
      setColor(resolveGroupColor(group?.color ?? null, group?.id ?? ''));
      setMode('empty');
      setCsvFile(null);
      setCsvText('');
      setCsvError(null);
      setCsvResult(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [open, group]);

  async function handleCsvFileSelected(selectedFile: File) {
    if (!selectedFile.name.toLowerCase().endsWith('.csv')) {
      toast.error('Please select a valid .csv file.');
      return;
    }
    setCsvError(null);
    setCsvFile(selectedFile);
    try {
      const text = await selectedFile.text();
      setCsvText(text);
    } catch {
      toast.error('Failed to read the selected file.');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t('nameRequired'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNoAccount'));
      return;
    }

    if (!isEdit && mode === 'from-csv') {
      if (!csvFile || !csvText.trim()) {
        setCsvError('Please select a CSV file.');
        return;
      }
      setSaving(true);
      setCsvError(null);
      try {
        const res = await fetch('/api/contacts/groups/create-from-csv', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: trimmed,
            description,
            color,
            csvText,
            fileName: csvFile.name,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error || 'Failed to create group from CSV.';
          setCsvError(msg);
          toast.error(msg);
          return;
        }
        setCsvResult(data);
        toast.success(
          `Group created: ${data.new_contacts_count} new, ${data.existing_added_count} existing added.`
        );
        if (data.group) onSaved?.(data.group);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Network error';
        setCsvError(msg);
        toast.error(msg);
      } finally {
        setSaving(false);
      }
      return;
    }

    setSaving(true);
    try {
      const saved = isEdit
        ? await updateGroup(supabase, group.id, {
            name: trimmed,
            description,
            color,
          })
        : await createGroup(supabase, {
            accountId,
            name: trimmed,
            description,
            color,
          });
      toast.success(isEdit ? t('toastUpdated') : t('toastCreated'));
      onOpenChange(false);
      onSaved?.(saved);
    } catch (err) {
      if (err instanceof GroupNameConflictError) {
        toast.error(t('toastDuplicate', { name: trimmed }));
      } else {
        toast.error(
          err instanceof Error ? err.message : t('toastFailed')
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? t('editTitle') : t('createTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEdit ? t('editDesc') : t('createDesc')}
          </DialogDescription>
        </DialogHeader>

        {!isEdit && !csvResult && (
          <div className="grid grid-cols-2 rounded-lg border border-border bg-muted/50 p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => {
                setMode('empty');
                setCsvError(null);
              }}
              className={cn(
                'rounded-md py-1.5 transition-colors',
                mode === 'empty'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Empty group
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('from-csv');
                setCsvError(null);
              }}
              className={cn(
                'rounded-md py-1.5 transition-colors',
                mode === 'from-csv'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              From CSV
            </button>
          </div>
        )}

        {csvResult ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-center gap-2 font-medium text-sm text-foreground">
                <CheckCircle2 className="size-4 text-emerald-500" />
                Group created &amp; import complete
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded bg-muted/60 p-2">
                  <span className="text-muted-foreground">Total rows:</span>
                  <p className="text-sm font-semibold text-foreground">{csvResult.total_rows}</p>
                </div>
                <div className="rounded bg-muted/60 p-2">
                  <span className="text-muted-foreground">Valid rows:</span>
                  <p className="text-sm font-semibold text-foreground">{csvResult.valid_rows}</p>
                </div>
                <div className="rounded bg-muted/60 p-2">
                  <span className="text-muted-foreground">New created:</span>
                  <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                    {csvResult.new_contacts_count}
                  </p>
                </div>
                <div className="rounded bg-muted/60 p-2">
                  <span className="text-muted-foreground">Existing added:</span>
                  <p className="text-sm font-semibold text-primary">
                    {csvResult.existing_added_count}
                  </p>
                </div>
                <div className="rounded bg-muted/60 p-2">
                  <span className="text-muted-foreground">Repeated in file:</span>
                  <p className="text-sm font-semibold text-muted-foreground">{csvResult.repeats_count}</p>
                </div>
                <div className="rounded bg-muted/60 p-2">
                  <span className="text-muted-foreground">Invalid rows:</span>
                  <p className="text-sm font-semibold text-muted-foreground">{csvResult.invalid_count}</p>
                </div>
              </div>
              {csvResult.invalid_count > 0 && (
                <div className="flex items-center justify-between pt-2 border-t border-border text-xs text-amber-600 dark:text-amber-400">
                  <span>{csvResult.invalid_count} invalid row(s) skipped</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      downloadInvalidRowsCsv(
                        csvResult.invalid_rows,
                        `invalid-${csvFile?.name || 'rows'}.csv`
                      )
                    }
                    className="h-7 gap-1 text-xs"
                  >
                    <Download className="size-3" />
                    Download list
                  </Button>
                </div>
              )}
            </div>
            <DialogFooter className="bg-popover border-border">
              <Button
                type="button"
                onClick={() => onOpenChange(false)}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="group-name" className="text-muted-foreground">
              {t('nameLabel')} <span className="text-red-400">*</span>
            </Label>
            <Input
              id="group-name"
              value={name}
              maxLength={GROUP_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
            <p className="text-xs text-muted-foreground">
              {t('nameHint', { max: GROUP_NAME_MAX })}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="group-description" className="text-muted-foreground">
              {t('descLabel')}
            </Label>
            <Input
              id="group-description"
              value={description}
              maxLength={GROUP_DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('descPlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          {/* Folder color — palette keys only; the DB CHECK mirrors
              GROUP_COLORS, and NULL rows render the id default. */}
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('colorLabel')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1.5">
                {GROUP_COLORS.map((def) => (
                  <button
                    key={def.key}
                    type="button"
                    onClick={() => setColor(def.key)}
                    aria-label={def.label}
                    aria-pressed={color === def.key}
                    title={def.label}
                    className={cn(
                      'group-folder size-7 rounded-full border border-border outline-none transition-transform',
                      'focus-visible:ring-2 focus-visible:ring-ring',
                      color === def.key
                        ? 'ring-2 ring-ring ring-offset-2 ring-offset-background'
                        : 'hover:scale-110'
                    )}
                    style={folderToneVars(def.key)}
                  >
                    <span
                      className="block size-full rounded-full"
                      style={{ background: 'var(--folder-front)' }}
                    />
                  </button>
                ))}
              </div>
              {/* live preview of the chosen shade */}
              <FolderPreview
                colorKey={color}
                className="ml-auto aspect-[4/3] w-16"
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('colorHint')}</p>
          </div>

          {!isEdit && mode === 'from-csv' && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <Label className="text-muted-foreground">
                  CSV File <span className="text-red-400">*</span>
                </Label>
                <button
                  type="button"
                  onClick={downloadSampleContactCsv}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <Download className="size-3" />
                  Download sample CSV
                </button>
              </div>
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const dropped = e.dataTransfer.files[0];
                  if (dropped) handleCsvFileSelected(dropped);
                }}
                className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 p-4 text-center transition-colors hover:bg-muted/70"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleCsvFileSelected(f);
                  }}
                />
                {csvFile ? (
                  <div className="flex items-center gap-2 text-xs text-foreground">
                    <FileText className="size-4 text-primary" />
                    <span className="font-medium truncate max-w-[220px]">{csvFile.name}</span>
                    <span className="text-muted-foreground">
                      ({(csvFile.size / 1024).toFixed(1)} KB)
                    </span>
                  </div>
                ) : (
                  <>
                    <Upload className="size-5 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">
                      Click or drag a CSV file (Name, CountryCode, Whatsapp)
                    </p>
                  </>
                )}
              </div>
              {csvError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
                  <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
                  <span>{csvError}</span>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="bg-popover border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isEdit
                ? t('save')
                : mode === 'from-csv'
                  ? 'Create & Import'
                  : t('create')}
            </Button>
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
