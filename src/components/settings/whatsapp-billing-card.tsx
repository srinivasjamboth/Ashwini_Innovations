'use client';

// ============================================================
// WhatsAppBillingCard — Settings → WhatsApp, connected state only.
//
// "Billing & payments (Meta)": message charges are billed by Meta, so
// the block hands customers straight to Meta Business Suite's Billing
// Hub (Accounts → Messaging accounts) for THEIR connected account —
// where the payment method, the current balance and "Add payment
// method" live.
//
// The URL is resolved once server-side via GET /api/whatsapp/billing-link
// (single helper behind it, portfolio id lazily cached). While it
// resolves the button shows a spinner; if the call fails outright the
// button still opens the base Billing Hub URL — the way to pay Meta
// must never be unreachable.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { META_BILLING_BASE_URL } from '@/lib/whatsapp/billing-link';

export function WhatsAppBillingCard() {
  const t = useTranslations('Settings.whatsapp.billing');

  const [url, setUrl] = useState<string>(META_BILLING_BASE_URL);
  const [resolving, setResolving] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/whatsapp/billing-link', {
          credentials: 'include',
        });
        if (!res.ok) return; // keep the base-URL fallback already set
        const data = (await res.json()) as { url?: unknown };
        // Only ever open business.facebook.com URLs — the endpoint
        // builds them, but a defensive check costs nothing.
        if (
          alive &&
          typeof data.url === 'string' &&
          data.url.startsWith('https://business.facebook.com/')
        ) {
          setUrl(data.url);
        }
      } catch {
        /* resolve failed → base Billing Hub URL stays */
      } finally {
        if (alive) setResolving(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function openBilling() {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h3 className="text-base font-bold text-foreground">{t('title')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('help')}</p>
      <div className="mt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={openBilling}
          className="border-border text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          {resolving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <ExternalLink className="size-4" aria-hidden />
          )}
          {t('button')}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">{t('accessNote')}</p>
      </div>
    </section>
  );
}
