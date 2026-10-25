'use client';

/**
 * WhatsApp Forms/Flows — list page.
 *
 * Reads the local catalog only (`GET /api/whatsapp-flows`); no Meta call
 * per row, so the page loads at the same speed whatever the connected
 * WABA looks like. The trade-off is stated on the row itself: the status
 * is what we last saw Meta say, not a live poll.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ClipboardList,
  ExternalLink,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCan } from '@/hooks/use-can';
import { usePlaygroundLink } from '@/hooks/use-playground-link';
import { fetchWhatsAppFlows } from '@/lib/whatsapp/forms-client';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/dashboard/empty-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CreateFormPanel } from './create-form-panel';
import type { WhatsAppFlow, WhatsAppFlowStatus } from '@/types';

/**
 * Status vocabulary. Meta's richer states (DEPRECATED / BLOCKED /
 * THROTTLED) are folded into `draft` server-side — the point of the
 * column is "can a template button use this?", and the answer for all
 * three is no.
 */
const STATUS_STYLES: Record<WhatsAppFlowStatus, string> = {
  draft: 'border-border bg-muted text-muted-foreground',
  published: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
  error: 'border-red-500/30 bg-red-500/10 text-red-500',
};

export function FormsManager() {
  const t = useTranslations('WhatsAppForms.list');
  const tStatus = useTranslations('WhatsAppForms.status');
  const canManage = useCan('edit-settings');
  const playground = usePlaygroundLink();

  const [flows, setFlows] = useState<WhatsAppFlow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<WhatsAppFlow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFlows(await fetchWhatsAppFlows());
    } catch (err) {
      // `null` flows keeps the spinner from resolving into an empty
      // table — "nothing to show yet" and "couldn't look" are different
      // screens, and only the first offers a Create CTA.
      setFlows(null);
      setError(err instanceof Error ? err.message : t('loadError'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/whatsapp-flows/${pendingDelete.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? t('deleteError'));
        return;
      }
      toast.success(t('deleted'));
      setPendingDelete(null);
      await load();
    } finally {
      setDeleting(false);
    }
  }

  /*
   * One render tree for every load outcome. The earlier shape of this
   * component returned early on `error`, which silently unmounted the
   * create panel and the delete dialog: the header's Create Form button
   * stayed visible and set `panelOpen`, but nothing was listening, so a
   * failed list read turned both CTAs into dead pixels. The header is
   * also exactly where you want to build a Form *after* the catalog
   * could not be read, so the panel has to survive the error.
   */
  return (
    <div className="space-y-6">
      <PageHeader
        onPlayground={playground.url}
        onCreate={() => setPanelOpen(true)}
        canManage={canManage}
        playgroundLabel={t('buildInPlayground')}
        createLabel={t('create')}
      />

      {error ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40">
          <p className="max-w-xl px-4 text-center text-sm text-red-500">{error}</p>
          <Button variant="outline" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      ) : flows === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : flows.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={t('emptyTitle')}
          hint={t('emptyDesc')}
          className="min-h-64"
          action={
            canManage ? (
              <Button onClick={() => setPanelOpen(true)}>
                <Plus className="size-4" />
                {t('create')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colName')}</TableHead>
                <TableHead>{t('colStatus')}</TableHead>
                <TableHead className="text-right">{t('colScreens')}</TableHead>
                <TableHead>{t('colCreatedAt')}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {flows.map((flow) => (
                <TableRow key={flow.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">
                        {flow.name}
                      </span>
                      {flow.meta_flow_id ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {flow.meta_flow_id}
                        </span>
                      ) : null}
                      {flow.status === 'error' && flow.error_message && (
                        // The reason is the actionable part of an errored
                        // row — without it "Error" tells you nothing about
                        // what to change in the JSON.
                        <span className="mt-1 max-w-md text-xs text-red-500">
                          {flow.error_message}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={STATUS_STYLES[flow.status]}
                    >
                      {tStatus(flow.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {flow.screens_count}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(flow.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <GatedButton
                      variant="ghost"
                      size="icon"
                      canAct={canManage}
                      gateReason="delete forms"
                      aria-label={t('delete')}
                      onClick={() => setPendingDelete(flow)}
                      className="text-muted-foreground hover:bg-red-950/30 hover:text-red-400 size-7"
                    >
                      <Trash2 className="size-3.5" />
                    </GatedButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateFormPanel open={panelOpen} onOpenChange={setPanelOpen} onCreated={() => void load()} />

      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteDesc', { name: pendingDelete?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)} disabled={deleting}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PageHeader({
  onPlayground,
  onCreate,
  canManage,
  playgroundLabel,
  createLabel,
}: {
  onPlayground: string;
  onCreate: () => void;
  canManage: boolean;
  playgroundLabel: string;
  createLabel: string;
}) {
  const t = useTranslations('WhatsAppForms.list');
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="flex items-center gap-2">
        {/* `target=_blank` is the whole point: the Playground lives on
            Meta's side of a login wall, and a redirect would strand an
            unfinished template or form behind it. Rendered as an anchor
            wearing the outline button's classes rather than a Button with
            a click handler — the browser's own middle-click / "open in
            new tab" affordances keep working. */}
        <a
          href={onPlayground}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: 'outline' }))}
        >
          <ExternalLink className="size-4" />
          {playgroundLabel}
        </a>
        <GatedButton
          canAct={canManage}
          gateReason="create forms" planFeature="whatsapp_forms"
          onClick={onCreate}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="size-4" />
          {createLabel}
        </GatedButton>
      </div>
    </div>
  );
}
