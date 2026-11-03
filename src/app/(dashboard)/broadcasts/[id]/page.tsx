'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast, BroadcastRecipient, RecipientStatus } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft,
  Loader2,
  Users,
  Send,
  CheckCheck,
  Eye,
  AlertCircle,
  MessageCircle,
  Filter,
  Download,
  ChevronDown,
  Trash2,
  PlayCircle,
  RotateCcw,
  CalendarClock,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBroadcastStatus,
  getRecipientStatus,
} from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';
import {
  formatScheduledInZone,
  getLocalTimeZone,
  getTimeZoneOptions,
  ScheduleTimeError,
  utcToZonedParts,
} from '@/lib/whatsapp/schedule-time';

interface StatCardProps {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ label, value, total, icon, color }: StatCardProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}>
          {icon}
        </div>
        <span className="text-xs text-muted-foreground">{pct}%</span>
      </div>
      <p className="mt-3 text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

/**
 * Pure-CSS funnel chart: decreasing-width rounded bars.
 * Width is relative to the largest step (typically Sent) so we
 * always render a full bar at the top and proportional tails.
 */
function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-foreground">Funnel</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 rounded-full bg-muted">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-foreground">
                  {step.value.toLocaleString()}
                  <span className="ml-2 text-muted-foreground/80">
                    ({pctOfSent}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
];

/**
 * CSV export helper — RFC 4180 quoting. Quote every field so
 * commas/newlines/quotes round-trip cleanly.
 */
function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('Broadcasts.detail');
  const tStatus = useTranslations('Broadcasts.status');
  const broadcastId = params.id as string;

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>(
    'all',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resumingScope, setResumingScope] = useState<
    'pending' | 'failed' | null
  >(null);
  // True while a self-continuing resume chain is driving the campaign to
  // completion on the server. Kept separate from resumingScope so the UI
  // can say "resuming automatically" rather than a single one-shot.
  const [autoRunning, setAutoRunning] = useState(false);
  // Re-entrancy guards: only one chain at a time, and the wizard's
  // ?autostart=1 kick-off fires exactly once per mount.
  const autoChainRef = useRef(false);
  const autostartFiredRef = useRef(false);
  // ---- Scheduling controls (scheduled broadcasts only) ----
  const [showReschedule, setShowReschedule] = useState(false);
  const [resDate, setResDate] = useState('');
  const [resTime, setResTime] = useState('');
  const [resTz, setResTz] = useState('UTC');
  const [schedulingBusy, setSchedulingBusy] = useState<'cancel' | 'reschedule' | null>(
    null,
  );

  const fetchData = useCallback(async () => {
    try {
      const supabase = createClient();

      const { data: bc, error: bcError } = await supabase
        .from('broadcasts')
        .select('*')
        .eq('id', broadcastId)
        .single();

      if (bcError) throw bcError;
      setBroadcast(bc);

      const { data: recs, error: recsError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcastId)
        .order('created_at', { ascending: false });

      if (recsError) throw recsError;
      setRecipients(recs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('notFound'));
    } finally {
      setLoading(false);
    }
  }, [broadcastId, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter],
  );

  function handleExport() {
    if (!broadcast) return;
    // Row-mode CSV campaigns keep one recipient per file row — the
    // export carries the line number so repeats stay distinguishable.
    // Other campaigns export the exact columns they always did.
    const hasCsvRows = recipients.some((r) => r.source_row != null);
    const header = [
      ...(hasCsvRows ? [t('table.row')] : []),
      t('table.contact'),
      t('table.phone'),
      t('table.status'),
      t('table.sent'),
      t('table.delivered'),
      t('table.read'),
      t('table.error'),
    ];
    const rows = recipients.map((r) => [
      ...(hasCsvRows ? [String(r.source_row ?? '')] : []),
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      r.status,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }

  /**
   * Hand the leftovers to the server (issue #472) and keep handing them
   * until the campaign is done.
   *
   * The wizard's send loop used to live in the tab that started the
   * campaign, so navigating away stranded the rest as 'pending'. The
   * recovery endpoint delivers one capped pass per call; a single click
   * therefore only ever finished a slice of a large, paced campaign (≈15
   * recipients with a 3 s delay), forcing the operator to click Resume
   * over and over. This chains the passes: fire one, wait for its
   * server-side lock to release, fire the next — until the endpoint
   * reports no backlog left. The claim lock (delivery_locked_at) makes
   * overlapping passes impossible, so no recipient is ever double-sent.
   */
  const RESUME_POLL_MS = 2000;
  const RESUME_PASS_TIMEOUT_MS = 7 * 60 * 1000;
  const RESUME_MAX_PASSES = 1000;

  function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wait for the running server pass to release the delivery lock —
   * `after()` clears `delivery_locked_at` in its finally. Refreshes the
   * page counts as it polls so the operator watches progress rather than a
   * frozen screen. Returns when the lock is clear or the per-pass ceiling
   * is hit (so a wedged pass can't hang the chain forever).
   */
  async function waitUntilPassSettles(supabase: ReturnType<typeof createClient>) {
    // The route claims the lock before it returns 202; a short beat lets
    // that write land before we start polling it.
    await sleep(500);
    const start = Date.now();
    while (Date.now() - start < RESUME_PASS_TIMEOUT_MS) {
      const { data } = await supabase
        .from('broadcasts')
        .select('delivery_locked_at')
        .eq('id', broadcastId)
        .single();
      if (!data?.delivery_locked_at) return;
      await fetchData();
      await sleep(RESUME_POLL_MS);
    }
  }

  const runResumeChain = useCallback(
    async (scope: 'pending' | 'failed') => {
      if (autoChainRef.current) return;
      autoChainRef.current = true;
      setAutoRunning(true);
      setResumingScope(scope);
      const supabase = createClient();
      let passes = 0;
      try {
        while (passes < RESUME_MAX_PASSES) {
          passes++;
          const res = await fetch(
            `/api/whatsapp/broadcast/${broadcastId}/resume`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scope }),
            },
          );
          const payload = await res.json().catch(() => ({}));

          if (res.status === 409) {
            // A scheduler tick or a previous chain owns the lock. Wait it
            // out and retry the same pass instead of surfacing an error.
            await waitUntilPassSettles(supabase);
            continue;
          }
          if (!res.ok) {
            toast.error(
              t('toastResumeFailed', {
                error: payload?.error || `HTTP ${res.status}`,
              }),
            );
            break;
          }

          // Delivery fans out server-side after the 202; let this pass
          // settle before queueing the next so the claim is never raced.
          await waitUntilPassSettles(supabase);
          await fetchData();

          // `remaining` is the backlog beyond THIS pass's cap. 0 means this
          // pass covered every sendable recipient — nothing left to chain.
          if ((payload.remaining ?? 0) <= 0) {
            toast.success(t('toastResumeAllDone'));
            break;
          }
        }
      } finally {
        autoChainRef.current = false;
        setAutoRunning(false);
        setResumingScope(null);
        await fetchData();
      }
    },
    // waitUntilPassSettles/sleep are stable per-render helpers; fetchData +
    // ids are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [broadcastId, fetchData, t],
  );

  function handleResume(scope: 'pending' | 'failed') {
    void runResumeChain(scope);
  }

  // Kick off delivery automatically when arriving straight from the wizard
  // (?autostart=1). The send was made server-resumable there; this drives
  // it to completion here without another click. Fires once per mount, and
  // only for a genuinely in-flight, unlocked send-now campaign — never a
  // scheduled one, and never one another pass already holds.
  useEffect(() => {
    if (loading || !broadcast || autostartFiredRef.current) return;
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('autostart') !== '1') {
      return;
    }
    autostartFiredRef.current = true;
    const pendingHere = recipients.some((r) => r.status === 'pending');
    if (
      broadcast.status === 'sending' &&
      !broadcast.delivery_locked_at &&
      pendingHere
    ) {
      // Defer off the synchronous effect path so the chain's first setState
      // isn't flagged as set-state-in-effect.
      const id = setTimeout(() => void runResumeChain('pending'), 0);
      return () => clearTimeout(id);
    }
  }, [loading, broadcast, recipients, runResumeChain]);

  async function handleDelete() {
    setDeleting(true);
    const supabase = createClient();
    // broadcast_recipients cascades on broadcasts.id (migration 001), so a
    // single delete is sufficient — the aggregate trigger in migration 003
    // is defined on broadcast_recipients but fires only on its own row
    // changes, not on a cascaded drop of the parent row.
    const { error: delErr } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', broadcastId);
    setDeleting(false);
    if (delErr) {
      toast.error(t('toastFailedDelete', { error: delErr.message }));
      return;
    }
    toast.success(t('toastDeleted'));
    router.push('/broadcasts');
  }

  /**
   * Cancel a scheduled broadcast before it fires. Server guards the
   * transition to status='scheduled', so a race with the scheduler cron
   * (which has already flipped it to 'sending') returns 409 rather than
   * pretending it un-sent delivered messages.
   */
  async function handleCancel() {
    setSchedulingBusy('cancel');
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${broadcastId}/cancel`, {
        method: 'POST',
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          t('toastCancelFailed', { error: payload?.error || `HTTP ${res.status}` }),
        );
        return;
      }
      toast.success(t('toastCancelled'));
      await fetchData();
    } finally {
      setSchedulingBusy(null);
    }
  }

  /** Open the inline reschedule editor, prefilled from the current plan. */
  function openReschedule() {
    if (!broadcast?.scheduled_at) return;
    const zone = broadcast.scheduled_tz || getLocalTimeZone();
    const parts = utcToZonedParts(broadcast.scheduled_at, zone);
    setResDate(parts.date);
    setResTime(parts.time);
    setResTz(zone);
    setShowReschedule(true);
  }

  /**
   * Move a scheduled broadcast to a new time. Sends the wall-clock parts
   * + zone and lets the server convert (single source of DST truth, the
   * tested schedule-time helper), so the browser and the eventual send
   * can never disagree on the instant.
   */
  async function handleReschedule() {
    if (!resDate || !resTime) {
      toast.error(t('rescheduleIncomplete'));
      return;
    }
    setSchedulingBusy('reschedule');
    try {
      const res = await fetch(
        `/api/whatsapp/broadcast/${broadcastId}/reschedule`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: resDate, time: resTime, timezone: resTz }),
        },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          t('toastRescheduleFailed', {
            error: payload?.error || `HTTP ${res.status}`,
          }),
        );
        return;
      }
      toast.success(t('toastRescheduled'));
      setShowReschedule(false);
      await fetchData();
    } catch (err) {
      toast.error(
        t('toastRescheduleFailed', {
          error: err instanceof ScheduleTimeError ? err.message : 'Unknown error',
        }),
      );
    } finally {
      setSchedulingBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !broadcast) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error ?? t('notFound')}</p>
        <Button variant="outline" onClick={() => router.push('/broadcasts')}>
          {t('backToBroadcasts')}
        </Button>
      </div>
    );
  }

  const status = getBroadcastStatus(broadcast.status);

  const pendingCount = recipients.filter((r) => r.status === 'pending').length;
  const retryableCount = recipients.filter((r) => r.status === 'failed').length;
  // A campaign whose tab went away sits in 'sending' with recipients
  // still pending and nothing left to move them. Name that state rather
  // than leaving a permanently pulsing "sending" badge.
  const isStalled = broadcast.status === 'sending' && pendingCount > 0;

  const funnelSteps: FunnelStep[] = [
    { label: t('stats.sent'), value: broadcast.sent_count, color: 'bg-primary' },
    { label: t('stats.delivered'), value: broadcast.delivered_count, color: 'bg-teal-500' },
    { label: t('stats.read'), value: broadcast.read_count, color: 'bg-blue-500' },
    { label: t('stats.replied'), value: broadcast.replied_count, color: 'bg-indigo-500' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push('/broadcasts')}
            className="border-border"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">{broadcast.name}</h1>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
              >
                {tStatus(status.label)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
              <span>{t('template', { name: broadcast.template_name })}</span>
              <span>-</span>
              <span>
                {t('createdAt', { date: new Date(broadcast.created_at).toLocaleDateString() })}
              </span>
            </div>
          </div>
        </div>

        {/* Delete — inline-confirm pattern matches the pipeline-settings
            "Delete Pipeline" flow. Mid-send broadcasts can't be deleted
            because orphaning in-flight Meta messages would leave the
            funnel inconsistent. */}
        {confirmDelete ? (
          <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
            <span className="text-red-300">{t('deletePrompt')}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="h-7 border-border bg-transparent text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
              className="h-7 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? t('deleting') : t('confirm')}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={broadcast.status === 'sending'}
            onClick={() => setConfirmDelete(true)}
            title={
              broadcast.status === 'sending'
                ? t('cannotDeleteSending')
                : t('deleteHover')
            }
            className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('delete')}
          </Button>
        )}
      </div>

      {/* Scheduled banner — only for a broadcast still waiting to fire.
          Shows the chosen wall-clock time + zone and offers the two
          pre-execution actions: reschedule and cancel. The server guards
          both with a status='scheduled' precondition. */}
      {broadcast.status === 'scheduled' && (
        <div className="space-y-3 rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-blue-400" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('scheduledFor')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {broadcast.scheduled_at
                    ? formatScheduledInZone(
                        broadcast.scheduled_at,
                        broadcast.scheduled_tz ?? undefined,
                      )
                    : '-'}
                  {broadcast.scheduled_tz ? ` · ${broadcast.scheduled_tz}` : ''}
                </p>
              </div>
            </div>
            {!showReschedule && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={openReschedule}
                  disabled={schedulingBusy !== null}
                  className="border-border text-muted-foreground hover:bg-muted"
                >
                  <CalendarClock className="h-3.5 w-3.5" />
                  {t('reschedule')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancel}
                  disabled={schedulingBusy !== null}
                  className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10"
                >
                  {schedulingBusy === 'cancel' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" />
                  )}
                  {t('cancelSchedule')}
                </Button>
              </div>
            )}
          </div>

          {showReschedule && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Input
                type="date"
                value={resDate}
                onChange={(e) => setResDate(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
              <Input
                type="time"
                value={resTime}
                onChange={(e) => setResTime(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
              <select
                value={resTz}
                onChange={(e) => setResTz(e.target.value)}
                className="h-9 rounded-md border border-border bg-muted px-3 text-sm text-foreground"
              >
                {getTimeZoneOptions().map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-2 sm:col-span-3">
                <Button size="sm" onClick={handleReschedule} disabled={schedulingBusy !== null}>
                  {schedulingBusy === 'reschedule' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CalendarClock className="h-3.5 w-3.5" />
                  )}
                  {t('confirmReschedule')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowReschedule(false)}
                  disabled={schedulingBusy !== null}
                  className="border-border text-muted-foreground hover:bg-muted"
                >
                  {t('cancel')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Resume / retry (issue #472). Only rendered when there is
          actually something outstanding. */}
      {(pendingCount > 0 || retryableCount > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
          <div className="text-sm">
            <p className="font-medium text-foreground">
              {isStalled ? t('resumeStalledTitle') : t('resumeTitle')}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {autoRunning && resumingScope === 'pending'
                ? t('autoResumeRunning')
                : isStalled
                ? t('resumeStalledHint', { count: pendingCount })
                : t('resumeHint', { count: retryableCount })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {pendingCount > 0 && (
              <Button
                size="sm"
                onClick={() => handleResume('pending')}
                disabled={resumingScope !== null}
              >
                {resumingScope === 'pending' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PlayCircle className="h-3.5 w-3.5" />
                )}
                {autoRunning && resumingScope === 'pending'
                  ? t('autoResumeRunning')
                  : t('resumePending', { count: pendingCount })}
              </Button>
            )}
            {retryableCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleResume('failed')}
                disabled={resumingScope !== null}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {resumingScope === 'failed' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                {t('retryFailed', { count: retryableCount })}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Stats — 6 cards: Total / Sent / Delivered / Read / Replied / Failed */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label={t('stats.totalRecipients')}
          value={broadcast.total_recipients}
          total={broadcast.total_recipients}
          icon={<Users className="h-4 w-4" />}
          color="bg-muted text-muted-foreground"
        />
        <StatCard
          label={t('stats.sent')}
          value={broadcast.sent_count}
          total={broadcast.total_recipients}
          icon={<Send className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label={t('stats.delivered')}
          value={broadcast.delivered_count}
          total={broadcast.total_recipients}
          icon={<CheckCheck className="h-4 w-4" />}
          color="bg-teal-500/10 text-teal-400"
        />
        <StatCard
          label={t('stats.read')}
          value={broadcast.read_count}
          total={broadcast.total_recipients}
          icon={<Eye className="h-4 w-4" />}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          label={t('stats.replied')}
          value={broadcast.replied_count}
          total={broadcast.total_recipients}
          icon={<MessageCircle className="h-4 w-4" />}
          color="bg-indigo-500/10 text-indigo-400"
        />
        <StatCard
          label={t('stats.failed')}
          value={broadcast.failed_count}
          total={broadcast.total_recipients}
          icon={<AlertCircle className="h-4 w-4" />}
          color="bg-red-500/10 text-red-400"
        />
      </div>

      <FunnelChart steps={funnelSteps} />

      {/* Recipients Table */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-foreground">
            {statusFilter !== 'all'
              ? t('recipientsHeader', { filtered: filteredRecipients.length, total: recipients.length })
              : t('recipientsHeaderAll', { total: recipients.length })}
          </h2>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-muted-foreground hover:bg-muted"
                  />
                }
              >
                <Filter className="h-3.5 w-3.5" />
                {statusFilter === 'all'
                  ? t('allStatuses')
                  : tStatus(getRecipientStatus(statusFilter).label)}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={() => setStatusFilter('all')}
                  className={
                    statusFilter === 'all' ? 'text-primary' : 'text-popover-foreground'
                  }
                >
                  {t('allStatuses')}
                </DropdownMenuItem>
                {RECIPIENT_STATUSES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={
                      statusFilter === s
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    }
                  >
                    {tStatus(getRecipientStatus(s).label)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={recipients.length === 0}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" />
              {t('exportCsv')}
            </Button>
          </div>
        </div>

        {filteredRecipients.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {recipients.length === 0
                ? t('noRecipients')
                : t('noRecipientsFilter')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">{t('table.contact')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.phone')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.sent')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.delivered')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.read')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.error')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRecipients.map((recipient) => {
                  const rStatus = getRecipientStatus(recipient.status);
                  return (
                    <TableRow key={recipient.id} className="border-border">
                      <TableCell className="font-medium text-foreground">
                        <div className="flex items-center gap-2">
                          {recipient.source === 'csv' &&
                            recipient.source_row != null && (
                              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                {t('table.rowLabel', { row: recipient.source_row })}
                              </span>
                            )}
                          {recipient.contact?.name ?? 'Unknown'}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.contact?.phone ?? '-'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}
                        >
                          {tStatus(rStatus.label)}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.sent_at
                          ? new Date(recipient.sent_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.delivered_at
                          ? new Date(recipient.delivered_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.read_at
                          ? new Date(recipient.read_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-red-400">
                        {recipient.error_message ?? '-'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
