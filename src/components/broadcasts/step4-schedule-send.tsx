'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save, CalendarClock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  getLocalTimeZone,
  getTimeZoneOptions,
  hasScheduleLead,
  ScheduleTimeError,
  utcToZonedParts,
  zonedTimeToUtc,
} from '@/lib/whatsapp/schedule-time';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

type SendMode = 'now' | 'schedule';

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  /** Fires the schedule path with the chosen UTC instant + IANA zone. */
  onSchedule: (scheduledAtIso: string, timezone: string) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSchedule,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [showScheduleConfirm, setShowScheduleConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  // ---- Scheduling state -------------------------------------------------
  const zones = useMemo(() => getTimeZoneOptions(), []);
  const [mode, setMode] = useState<SendMode>('now');
  const [dateStr, setDateStr] = useState('');
  const [timeStr, setTimeStr] = useState('');
  const [timezone, setTimezone] = useState(() => getLocalTimeZone());

  // Resolve the wall-clock pick to a UTC instant, or surface why it's not
  // usable yet. `nowMs` re-ticks while schedule mode is open so the check
  // is always evaluated against the CURRENT instant — a time that lapses
  // while the user fills the form re-flags itself instead of going stale
  // and getting bounced by the server on submit. The acceptance window
  // (hasScheduleLead) is the exact rule the schedule endpoint enforces.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (mode !== 'schedule') return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [mode]);

  const schedule = useMemo<{ iso: string | null; error: string | null }>(() => {
    if (!dateStr || !timeStr) {
      return { iso: null, error: null };
    }
    try {
      const when = zonedTimeToUtc(dateStr, timeStr, timezone);
      if (!hasScheduleLead(when, new Date(nowMs))) {
        return { iso: null, error: t('scheduleSend.pastError') };
      }
      return { iso: when.toISOString(), error: null };
    } catch (err) {
      return {
        iso: null,
        error: err instanceof ScheduleTimeError ? err.message : t('scheduleSend.invalidError'),
      };
    }
  }, [dateStr, timeStr, timezone, t, nowMs]);

  // The date picker's earliest day, in the viewer's chosen zone (not UTC
  // — before ~05:30 IST a UTC-based floor would wrongly offer yesterday).
  const minDate = utcToZonedParts(new Date(nowMs), timezone).date;

  const canSchedule = Boolean(name.trim() && schedule.iso && !isProcessing);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.language')}</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Send mode: now vs schedule. */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          {t('scheduleSend.when')}
        </label>
        <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
          {(['now', 'schedule'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              disabled={isProcessing}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                mode === m
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {m === 'now' ? t('scheduleSend.modeNow') : t('scheduleSend.modeSchedule')}
            </button>
          ))}
        </div>
      </div>

      {/* Scheduling fields — only in schedule mode. */}
      {mode === 'schedule' && (
        <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium text-foreground">
              {t('scheduleSend.scheduleFor')}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {t('scheduleSend.date')}
              </label>
              <Input
                type="date"
                value={dateStr}
                min={minDate}
                onChange={(e) => setDateStr(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                {t('scheduleSend.time')}
              </label>
              <Input
                type="time"
                value={timeStr}
                onChange={(e) => setTimeStr(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t('scheduleSend.timezone')}
            </label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-muted px-3 text-sm text-foreground"
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
          {schedule.error && (
            <p className="text-xs text-red-400">{schedule.error}</p>
          )}
        </div>
      )}

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">{t('scheduleSend.sending')}</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          {mode === 'now' ? (
          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!name.trim() || isProcessing}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            <Send className="h-4 w-4" />
            {t('scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('scheduleSend.confirmTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t.rich('scheduleSend.confirmDesc', {
                  count: estimatedReach,
                  template: template.name,
                  b: (chunks) => (
                    <span className="font-medium text-popover-foreground">{chunks}</span>
                  ),
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onSend();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Send className="h-4 w-4" />
                {t('scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
          ) : (
          <Dialog open={showScheduleConfirm} onOpenChange={setShowScheduleConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!canSchedule}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            <CalendarClock className="h-4 w-4" />
            {t('scheduleSend.scheduleButton')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('scheduleSend.scheduleConfirmTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t.rich('scheduleSend.scheduleConfirmDesc', {
                  count: estimatedReach,
                  when: schedule.iso
                    ? new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: timezone,
                      }).format(new Date(schedule.iso))
                    : '',
                  b: (chunks) => (
                    <span className="font-medium text-popover-foreground">{chunks}</span>
                  ),
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowScheduleConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  if (!schedule.iso) return;
                  setShowScheduleConfirm(false);
                  onSchedule(schedule.iso, timezone);
                }}
                disabled={!schedule.iso}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <CalendarClock className="h-4 w-4" />
                {t('scheduleSend.scheduleButton')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
          )}
        </div>
      </div>
    </div>
  );
}
