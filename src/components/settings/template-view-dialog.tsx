'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { TemplatePreview } from './template-preview';

/**
 * Read-only "View template" popup for the Templates table.
 *
 * Shows ONLY the phone mock — the WhatsApp-style preview the customer
 * will actually receive — centred in the dialog, with the chat area
 * scrollable so a long template stays fully reviewable inside the device.
 * It reuses the SAME TemplatePreview the builder uses (one renderer, so
 * the preview can never drift from what was created) and fetches the
 * record by id when the popup opens (not from builder state), so
 * synced-from-Meta rows preview with their stored content too.
 *
 * Variable fallback chain: locally stored sample values first; for
 * templates synced from Meta without local samples the raw {{n}} tokens
 * stay visible (TemplatePreview highlights them), which is honest about
 * there being no example to show.
 */

interface TemplateViewDialogProps {
  /** Id of the template to show; null closes the popup. */
  templateId: string | null;
  onClose: () => void;
  /** Business name for the mock chat header — from the connected account. */
  accountName: string;
}

export function TemplateViewDialog({
  templateId,
  onClose,
  accountName,
}: TemplateViewDialogProps) {
  const t = useTranslations('Settings.templates');
  const supabase = createClient();

  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const fetchDetail = useCallback(async () => {
    if (!templateId) return;
    setLoading(true);
    setError(false);
    setTemplate(null);
    try {
      const { data, error: err } = await supabase
        .from('message_templates')
        .select('*')
        .eq('id', templateId)
        .single();
      if (err || !data) throw err ?? new Error('not found');
      setTemplate(data as MessageTemplate);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  useEffect(() => {
    if (templateId) void fetchDetail();
  }, [templateId, fetchDetail]);

  return (
    <Dialog open={templateId !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Transparent, chrome-free container: ONLY the phone shows — no
          white panel behind it. Closes on backdrop click or Escape. */}
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[92vh] w-fit max-w-[92vw] flex-col items-center gap-0 overflow-y-auto bg-transparent p-0 shadow-none ring-0 sm:max-w-none"
        aria-label={t('viewSheetTitle')}
      >
        {loading && (
          /* Phone-shaped skeleton while the detail row loads. */
          <div className="mx-auto aspect-[9/19] w-[300px] max-w-full animate-pulse rounded-[2.4rem] border-[10px] border-[#015482]/30 bg-muted" />
        )}

        {!loading && error && (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertCircle className="size-6 text-red-400" />
            <p className="text-sm text-muted-foreground">{t('viewSheetLoadFailed')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchDetail()}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <RefreshCw className="size-3.5" />
              {t('formsRetry')}
            </Button>
          </div>
        )}

        {!loading && !error && template && (
          <div className="mx-auto w-[300px] max-w-full">
            <TemplatePreview
              headerFormat={(template.header_type ?? 'none') as 'none' | 'text' | 'image' | 'video' | 'document'}
              headerContent={template.header_content ?? ''}
              headerMediaUrl={template.header_media_url ?? ''}
              bodyText={template.body_text ?? ''}
              bodySamples={template.sample_values?.body ?? []}
              footerText={template.footer_text ?? ''}
              buttons={template.buttons ?? []}
              businessName={accountName}
              showButtonIcons
              scrollableContent
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
