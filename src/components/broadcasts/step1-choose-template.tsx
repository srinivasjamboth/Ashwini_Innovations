'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TemplatePreview } from '@/components/settings/template-preview';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  FileText,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * A recipient shown in the phone preview. Real contacts carry the full
 * field set; CSV uploads only ever have phone + optional name (the CSV
 * parser drops everything else), so email/company mappings stay as raw
 * tokens for those — honest rather than invented.
 */
interface PreviewRecipient {
  id: string;
  name: string | null;
  phone: string;
  email?: string | null;
  company?: string | null;
}

interface VariableMapping {
  type: 'static' | 'field' | 'custom_field';
  value: string;
}

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
  /**
   * CSV audience from the wizard (step 2). When present it IS the
   * recipient list, so "Previewing as" steps through exactly the people
   * who will receive the broadcast. Optional so the component keeps
   * working if the wizard doesn't pass it.
   */
  audienceCsvContacts?: { phone: string; name?: string }[];
  /**
   * Variable mappings from step 3. Only relevant when the user steps
   * back to the template screen — the preview then reflects the exact
   * values each recipient will get instead of the Meta sample values.
   */
  variables?: Record<string, VariableMapping>;
}

/**
 * Brand blue for the broadcast preview frame — the app's fixed navy
 * (same value as --sidebar in both light and dark themes, so it never
 * shifts with the accent picker). The shared TemplatePreview keeps its
 * own #015482 default everywhere else.
 */
const BRAND_FRAME_BLUE = '#002f69';

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length === 1) return words[0].charAt(0);
  return words[0].charAt(0) + words[1].charAt(0);
}

export function Step1ChooseTemplate({
  selectedTemplate,
  onSelect,
  onNext,
  onBack,
  audienceCsvContacts,
  variables,
}: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const { accountId, account } = useAuth();

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Preview inputs: connected business name, stepping recipients, and
  // the current recipient's custom-field values (only fetched when a
  // mapping actually uses one).
  const [businessName, setBusinessName] = useState('');
  const [contacts, setContacts] = useState<PreviewRecipient[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [customValues, setCustomValues] = useState<Map<string, string>>(new Map());

  // Only APPROVED templates can be sent via Meta — anything else would
  // 400 at broadcast time. select('*') ships the full detail row
  // (header/body/footer/buttons/samples), so picking one from the
  // dropdown needs no second fetch to fill the preview.
  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from('message_templates')
        .select('*')
        .eq('status', 'APPROVED')
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      setTemplates(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('chooseTemplate.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  // Real connected business name for the preview header: Meta's
  // verified display name first, account name as the fallback.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('whatsapp_config')
        .select('verified_name')
        .eq('account_id', accountId)
        .limit(1);
      if (!cancelled) {
        setBusinessName(data?.[0]?.verified_name || account?.name || '');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, account?.name]);

  // Preview recipients: the uploaded CSV when one exists (it's the
  // literal audience), otherwise a page of real contacts so Step 1 can
  // already show per-recipient values before the audience is narrowed.
  useEffect(() => {
    if (audienceCsvContacts?.length) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('contacts')
        .select('id, name, phone, email, company')
        .order('created_at', { ascending: false })
        .limit(100);
      if (!cancelled) setContacts((data ?? []) as PreviewRecipient[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [audienceCsvContacts]);

  const recipients = useMemo<PreviewRecipient[]>(() => {
    if (audienceCsvContacts?.length) {
      return audienceCsvContacts.map((c, i) => ({
        id: `csv:${i}:${c.phone}`,
        name: c.name ?? null,
        phone: c.phone,
      }));
    }
    return contacts;
  }, [audienceCsvContacts, contacts]);

  // Clamp in case the list shrank (CSV swapped out between wizard steps).
  const safeIndex = Math.min(previewIndex, Math.max(recipients.length - 1, 0));
  const recipient = recipients[safeIndex] ?? null;

  // A template change restarts the walkthrough at the first recipient.
  useEffect(() => {
    setPreviewIndex(0);
  }, [selectedTemplate?.id]);

  const usesCustomField = useMemo(
    () => Boolean(variables && Object.values(variables).some((v) => v.type === 'custom_field')),
    [variables],
  );

  // Custom-field values for the recipient currently being previewed.
  // CSV ids are synthetic — only real contact rows can have them.
  useEffect(() => {
    if (!usesCustomField || !recipient || recipient.id.startsWith('csv:')) {
      setCustomValues((prev) => (prev.size ? new Map() : prev));
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from('contact_custom_values')
        .select('custom_field_id, value')
        .eq('contact_id', recipient.id);
      if (cancelled) return;
      const map = new Map<string, string>();
      for (const row of data ?? []) map.set(row.custom_field_id, row.value ?? '');
      setCustomValues(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [usesCustomField, recipient]);

  /**
   * Body variable values for the previewed recipient, positional
   * (index N-1 ↔ {{N}}) exactly like the send-time resolver:
   * mapping wins when it resolves against this recipient, otherwise the
   * template's Meta sample values stand in, and with no recipient at
   * all everything stays a raw {{N}} token (TemplatePreview highlights
   * unresolved tokens rather than hiding them).
   */
  const bodySamples = useMemo(() => {
    if (!selectedTemplate) return [];
    const matches = [...selectedTemplate.body_text.matchAll(/\{\{(\d+)\}\}/g)];
    if (!matches.length) return [];
    const max = Math.max(...matches.map((m) => Number(m[1])));
    if (!recipient) return [];

    const fieldMap: Record<string, string | null | undefined> = {
      name: recipient.name,
      phone: recipient.phone,
      email: recipient.email,
      company: recipient.company,
    };

    const out: string[] = new Array(max).fill('');
    for (let n = 1; n <= max; n++) {
      const mapping = variables?.[String(n)];
      let value = '';
      if (mapping?.value) {
        if (mapping.type === 'static') {
          value = mapping.value;
        } else if (mapping.type === 'field') {
          value = fieldMap[mapping.value] ?? '';
        } else if (mapping.type === 'custom_field') {
          value = customValues.get(mapping.value) ?? '';
        }
      }
      if (!value) value = selectedTemplate.sample_values?.body?.[n - 1]?.trim() ?? '';
      out[n - 1] = value;
    }
    return out;
  }, [selectedTemplate, recipient, variables, customValues]);

  const recipientLabel = recipient ? recipient.name || recipient.phone : '';

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-10">
      {/* ---------------- Left: the form ---------------- */}
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('chooseTemplate.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('chooseTemplate.subtitle')}
          </p>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            {t('chooseTemplate.label')}
          </label>

          {loading ? (
            /* Skeleton while the approved list loads. */
            <div className="space-y-2" aria-hidden>
              <div className="h-9 w-full max-w-md animate-pulse rounded-lg bg-muted" />
              <div className="h-4 w-2/3 max-w-sm animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/2 max-w-xs animate-pulse rounded bg-muted" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-red-400">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadTemplates()}
                className="border-border text-muted-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('chooseTemplate.retry')}
              </Button>
            </div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-xl border border-border bg-card/50 p-4">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {t('chooseTemplate.noApproved')}
                </p>
              </div>
              <Button
                variant="link"
                size="sm"
                render={<Link href="/templates" />}
                className="h-auto p-0 text-primary"
              >
                {t('chooseTemplate.browseTemplates')}
              </Button>
            </div>
          ) : (
            <Select
              value={selectedTemplate?.id ?? null}
              onValueChange={(value) => {
                if (value == null) return;
                const template = templates.find((tpl) => tpl.id === value);
                if (template) onSelect(template);
              }}
            >
              <SelectTrigger className="w-full max-w-md border-border bg-muted text-foreground">
                {/* Formatter keeps the trigger to the template name —
                    the two-line label lives in the dropdown items. */}
                <SelectValue placeholder={t('chooseTemplate.placeholder')}>
                  {(value: unknown) =>
                    templates.find((tpl) => tpl.id === value)?.name ??
                    t('chooseTemplate.placeholder')
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="border-border bg-popover" alignItemWithTrigger={false}>
                {templates.map((template) => (
                  <SelectItem
                    key={template.id}
                    value={template.id}
                    label={template.name}
                    className="items-start py-1.5"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{template.name}</span>
                      <span className="whitespace-normal text-xs text-muted-foreground">
                        {template.category} · {template.language ?? 'en_US'}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border pt-4">
          <Button
            variant="outline"
            onClick={onBack}
            className="border-border text-muted-foreground"
          >
            {t('back')}
          </Button>
          <Button
            onClick={onNext}
            disabled={!selectedTemplate}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('next')}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ---------------- Right: sticky phone preview ---------------- */}
      <div className="self-start lg:sticky lg:top-20">
        <TemplatePreview
          headerFormat={(selectedTemplate?.header_type ?? 'none') as
            | 'none'
            | 'text'
            | 'image'
            | 'video'
            | 'document'}
          headerContent={selectedTemplate?.header_content ?? ''}
          headerMediaUrl={selectedTemplate?.header_media_url ?? ''}
          bodyText={selectedTemplate?.body_text ?? ''}
          bodySamples={bodySamples}
          footerText={selectedTemplate?.footer_text ?? ''}
          buttons={selectedTemplate?.buttons ?? []}
          businessName={businessName}
          businessInitials={initialsOf(businessName)}
          showButtonIcons
          scrollableContent
          frameColor={BRAND_FRAME_BLUE}
          emptyMessage={t('chooseTemplate.previewEmpty')}
        />

        {/* Recipient stepper sits under the phone, not above it. */}
        {selectedTemplate && recipients.length > 0 && (
          <div className="mt-2 flex items-center justify-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('chooseTemplate.prevRecipient')}
              disabled={safeIndex === 0}
              onClick={() => setPreviewIndex((i) => Math.max(i - 1, 0))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {t('chooseTemplate.previewingAs')}{' '}
              <span className="font-medium text-foreground">{recipientLabel}</span>
              {' '}
              ({safeIndex + 1}/{recipients.length})
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('chooseTemplate.nextRecipient')}
              disabled={safeIndex >= recipients.length - 1}
              onClick={() =>
                setPreviewIndex((i) => Math.min(i + 1, recipients.length - 1))
              }
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {selectedTemplate && recipients.length === 0 && (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            {t('chooseTemplate.noRecipientsHint')}
          </p>
        )}
      </div>
    </div>
  );
}
