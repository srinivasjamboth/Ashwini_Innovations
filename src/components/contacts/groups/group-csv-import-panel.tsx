'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  Upload,
  Download,
  AlertCircle,
  CheckCircle2,
  Loader2,
  FileText,
  X,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { downloadSampleContactCsv } from '@/lib/contacts/csv-sample';
import type { GroupCsvImportResult, InvalidRowDetail } from '@/lib/contacts/group-csv-import';

interface GroupCsvImportPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  groupName: string;
  onComplete?: () => void;
}

export function downloadInvalidRowsCsv(
  invalidRows: InvalidRowDetail[],
  fileName = 'invalid-rows.csv'
): void {
  const headers = ['Row', 'Phone', 'Name', 'Reason'];
  const lines = [headers.join(',')];
  for (const r of invalidRows) {
    const safePhone = `"${(r.phone ?? '').replace(/"/g, '""')}"`;
    const safeName = `"${(r.name ?? '').replace(/"/g, '""')}"`;
    const safeReason = `"${(r.reason ?? '').replace(/"/g, '""')}"`;
    lines.push([r.row, safePhone, safeName, safeReason].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function GroupCsvImportPanel({
  open,
  onOpenChange,
  groupId,
  groupName,
  onComplete,
}: GroupCsvImportPanelProps) {
  const t = useTranslations('Contacts.importModal');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState<string>('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<GroupCsvImportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setCsvText('');
    setResult(null);
    setErrorMsg(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      if (result?.success) {
        onComplete?.();
      }
      reset();
    }
    onOpenChange(next);
  }

  async function handleFileSelected(selectedFile: File) {
    if (!selectedFile.name.endsWith('.csv')) {
      toast.error('Please select a valid .csv file.');
      return;
    }
    setErrorMsg(null);
    setResult(null);
    setFile(selectedFile);
    try {
      const text = await selectedFile.text();
      setCsvText(text);
    } catch {
      toast.error('Failed to read the selected file.');
    }
  }

  async function handleImport() {
    if (!csvText || !file) return;
    setImporting(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/contacts/groups/${groupId}/import-csv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csvText,
          fileName: file.name,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = data?.error || 'CSV import failed';
        setErrorMsg(msg);
        toast.error(msg);
        if (data?.invalid_rows && Array.isArray(data.invalid_rows)) {
          setResult({
            jobId: '',
            success: false,
            total_rows: 0,
            valid_rows: 0,
            new_contacts_count: 0,
            existing_added_count: 0,
            already_in_group_count: 0,
            repeats_count: 0,
            invalid_count: data.invalid_rows.length,
            invalid_rows: data.invalid_rows,
            error: msg,
          });
        }
        return;
      }

      setResult(data as GroupCsvImportResult);
      toast.success(
        `Import complete: ${data.new_contacts_count} created, ${data.existing_added_count} added, ${data.already_in_group_count} already in group.`
      );
      onComplete?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col sm:max-w-md p-0 overflow-y-auto"
      >
        <SheetHeader className="border-b border-border p-5">
          <SheetTitle className="flex items-center gap-2 text-foreground font-semibold text-lg">
            <Upload className="size-5 text-primary" />
            Import CSV into Group
          </SheetTitle>
          <SheetDescription className="text-muted-foreground text-xs">
            Add contacts to <span className="font-medium text-foreground">{groupName}</span> via CSV file.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 p-5">
          {/* Sample CSV Download Link */}
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/40 p-3">
            <div className="text-xs text-muted-foreground">
              Required: <span className="font-semibold text-foreground">Name, CountryCode, Whatsapp</span>
              <br />
              Extra columns will be saved as contact attributes.
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadSampleContactCsv}
              className="gap-1.5 text-xs font-medium"
            >
              <Download className="size-3.5" />
              Sample CSV
            </Button>
          </div>

          {/* Dropzone */}
          {!result && (
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const dropped = e.dataTransfer.files[0];
                if (dropped) handleFileSelected(dropped);
              }}
              className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card p-6 text-center transition-all hover:bg-muted/50"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFileSelected(f);
                }}
              />
              <div className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <FileText className="size-6 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {file ? file.name : 'Click to upload or drag & drop'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {file
                    ? `${(file.size / 1024).toFixed(1)} KB`
                    : 'CSV files only (up to 10,000+ rows)'}
                </p>
              </div>
              {file && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    reset();
                  }}
                  className="text-xs text-muted-foreground hover:text-destructive h-7"
                >
                  Change file
                </Button>
              )}
            </div>
          )}

          {/* Error Message */}
          {errorMsg && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="size-4 shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Results Summary Card */}
          {result && (
            <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-center gap-2 font-medium text-sm text-foreground">
                <CheckCircle2 className="size-4 text-emerald-500" />
                Import Summary
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded bg-muted/60 p-2.5">
                  <span className="text-muted-foreground">Total rows in file:</span>
                  <p className="text-base font-semibold text-foreground">{result.total_rows}</p>
                </div>
                <div className="rounded bg-muted/60 p-2.5">
                  <span className="text-muted-foreground">Valid rows:</span>
                  <p className="text-base font-semibold text-foreground">{result.valid_rows}</p>
                </div>
                <div className="rounded bg-muted/60 p-2.5">
                  <span className="text-muted-foreground">New contacts created:</span>
                  <p className="text-base font-semibold text-emerald-600 dark:text-emerald-400">
                    {result.new_contacts_count}
                  </p>
                </div>
                <div className="rounded bg-muted/60 p-2.5">
                  <span className="text-muted-foreground">Existing added to group:</span>
                  <p className="text-base font-semibold text-primary">
                    {result.existing_added_count}
                  </p>
                </div>
                <div className="rounded bg-muted/60 p-2.5">
                  <span className="text-muted-foreground">Already in group:</span>
                  <p className="text-base font-semibold text-muted-foreground">
                    {result.already_in_group_count}
                  </p>
                </div>
                <div className="rounded bg-muted/60 p-2.5">
                  <span className="text-muted-foreground">Repeated in file:</span>
                  <p className="text-base font-semibold text-muted-foreground">
                    {result.repeats_count}
                  </p>
                </div>
              </div>

              {result.invalid_count > 0 && (
                <div className="space-y-2 pt-2 border-t border-border">
                  <div className="flex items-center justify-between text-xs text-amber-600 dark:text-amber-400 font-medium">
                    <span>Invalid / skipped rows: {result.invalid_count}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => downloadInvalidRowsCsv(result.invalid_rows, `invalid-${file?.name || 'rows'}.csv`)}
                      className="gap-1 text-xs h-7"
                    >
                      <Download className="size-3" />
                      Download list
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <SheetFooter className="border-t border-border p-4 bg-muted/20">
          {!result ? (
            <div className="flex items-center justify-end gap-2 w-full">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleOpenChange(false)}
                disabled={importing}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleImport}
                disabled={!file || importing}
                className="gap-1.5"
              >
                {importing ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Upload className="size-3.5" />
                    Import Contacts
                  </>
                )}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-end w-full">
              <Button size="sm" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </div>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
