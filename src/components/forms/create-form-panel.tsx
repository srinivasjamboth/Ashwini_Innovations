'use client';

/**
 * Create Form slide-over — the one place a Flow JSON becomes a live Flow.
 *
 * Embedded twice: full-screen from the Forms page, and inline from the
 * Template Builder (which opens *this* panel rather than navigating away,
 * so a half-built template isn't lost mid-edit). `onCreated` is how the
 * builder learns the new Flow exists.
 *
 * Failure handling is deliberately inline. A Meta rejection arrives with
 * the stored row (`status='error'`, `error_message`), and the reason —
 * "Field 'xyz' is required on screen 'Lead' (at /screens/0/components/2)"
 * — is only useful next to the JSON that caused it. A toast would vanish
 * before it could be read, so nothing about a rejection leaves the panel.
 */

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertCircle, Info, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  inspectFlowJson,
  type FlowJsonInspection,
} from '@/lib/whatsapp/flow-json';
import { usePlaygroundLink } from '@/hooks/use-playground-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { WhatsAppFlow } from '@/types';

/**
 * How long after the last keystroke we re-check the JSON. The check is
 * pure and local, so the debounce is about not flickering an error under
 * someone mid-paste, not about cost. Blur skips the wait entirely.
 */
const VALIDATE_DEBOUNCE_MS = 400;

export function CreateFormPanel({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after Meta has published the Flow and we've stored it. */
  onCreated?: (flow: WhatsAppFlow) => void;
}) {
  const t = useTranslations('WhatsAppForms.panel');
  const tIssues = useTranslations('WhatsAppForms.panel.issues');
  const playground = usePlaygroundLink();

  const [name, setName] = useState('');
  const [json, setJson] = useState('');
  const [check, setCheck] = useState<FlowJsonInspection | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-opening a panel that failed last time should not re-show the old
  // rejection: the JSON on screen may already have been edited elsewhere.
  useEffect(() => {
    if (open) return;
    setRejection(null);
  }, [open]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (json.trim().length === 0) {
      setCheck(null);
      return;
    }
    timer.current = setTimeout(() => setCheck(inspectFlowJson(json)), VALIDATE_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [json]);

  // The button gate uses a fresh structural check rather than `check`,
  // which lags the debounce by design. Disabled must never be a surprise,
  // but it must also never be wrong.
  const liveCheck = inspectFlowJson(json);
  const canSubmit = name.trim().length > 0 && liveCheck.ok && !submitting;

  function validateNow() {
    setCheck(inspectFlowJson(json));
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setRejection(null);
    try {
      const res = await fetch('/api/whatsapp-flows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, flow_json: json }),
      });
      const body = (await res.json().catch(() => null)) as {
        flow?: WhatsAppFlow;
        error?: string;
      } | null;

      if (!res.ok || !body?.flow) {
        setRejection(body?.error ?? t('submitFailed'));
        return;
      }

      toast.success(t('created'));
      setName('');
      setJson('');
      setCheck(null);
      onCreated?.(body.flow);
      onOpenChange(false);
    } catch (err) {
      setRejection(err instanceof Error ? err.message : t('submitFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-xl gap-0 p-0">
        <SheetHeader className="shrink-0 border-b border-border">
          <SheetTitle>{t('title')}</SheetTitle>
          <SheetDescription>{t('subtitle')}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-1">
          {/* Info callout — light blue tint, and a link that always opens
              in a new tab: leaving the builder mid-edit would drop the form. */}
          <div className="flex gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
            <Info className="mt-0.5 size-4 shrink-0 text-sky-500" />
            <div className="space-y-1 text-xs text-foreground/90">
              <p className="font-medium">{t('playgroundHeading')}</p>
              <p className="text-muted-foreground">{t('playgroundBody')}</p>
              <a
                href={playground.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
              >
                {t('playgroundOpen')}
                <span aria-hidden>↗</span>
              </a>
              {!playground.scoped && (
                <p className="pt-1 text-muted-foreground">
                  {playground.wabaId
                    ? t('playgroundSelectAccount', { wabaId: playground.wabaId })
                    : t('playgroundSelectBusiness')}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="flow-name">{t('nameLabel')}</Label>
            <Input
              id="flow-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              maxLength={100}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="flow-json">{t('jsonLabel')}</Label>
            <Textarea
              id="flow-json"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              onBlur={validateNow}
              placeholder={t.raw('jsonPlaceholder')}
              spellCheck={false}
              className="min-h-64 font-mono text-xs"
            />
            <div className="flex items-start gap-1.5">
              {check && !check.ok ? (
                <p className="flex items-start gap-1 text-xs text-red-500">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  {tIssues(check.issue ?? 'invalidJson')}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t('jsonHelper')}</p>
              )}
            </div>
          </div>

          {rejection && (
            <div
              role="alert"
              className="flex gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
              <div className="space-y-1 text-xs">
                <p className="font-medium text-red-500">{t('rejectedHeading')}</p>
                <p className="whitespace-pre-wrap text-foreground/90">{rejection}</p>
              </div>
            </div>
          )}
        </div>

        <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t border-border">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {t('submit')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
