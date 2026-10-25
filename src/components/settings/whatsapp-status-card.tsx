'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Loader2, Phone, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { WhatsAppPhoneNumber } from '@/types';

/**
 * Connection status card for a WhatsApp number that has been set up.
 *
 * It reports the ONE thing the owner actually cares about — whether the
 * number is connected — driven by the live health-check result passed in
 * as `connected`. It deliberately does NOT surface Meta's `name_status`
 * display-name approval (Approved / Pending / Rejected): a working,
 * verified number can legitimately sit at "Pending" there, which read as
 * a false alarm on this card. The colored approval block is gone.
 *
 * The card reflects the ACTIVE number (business name + phone from the
 * health check). Underneath, the synced WABA catalog (migration 047)
 * lists every number Meta sees under the account — when there's more
 * than one, each gets a "Set as active" action so sends can be switched
 * without reconnecting.
 */
type Props = {
  businessName: string;
  phoneNumber: string;
  /** Live connection state from GET /api/whatsapp/config. */
  connected: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  disconnecting: boolean;
  onDisconnect: () => void;
  /** Full synced number catalog for the account (may be empty). */
  numbers: WhatsAppPhoneNumber[];
  /** Admin+ — only then is "Set as active" offered (mirrors RLS). */
  canSwitch: boolean;
  /** phone_number_id of the in-flight switch, for the row spinner. */
  switchingId: string | null;
  onSetActive: (phoneNumberId: string) => void;
};

export function WhatsAppStatusCard({
  businessName,
  phoneNumber,
  connected,
  refreshing,
  onRefresh,
  disconnecting,
  onDisconnect,
  numbers,
  canSwitch,
  switchingId,
  onSetActive,
}: Props) {
  const t = useTranslations('Settings.whatsapp');

  // Numbers Meta still lists. Soft-removed rows stay in the table for
  // message-history resolution but are not actionable here.
  const live = numbers.filter((n) => !n.removed_at);
  const hasActive = live.some((n) => n.is_active);
  // The catalog only speaks once a sync has populated it — an account
  // predating migration 047 shows the classic single-number card until
  // its first refresh/backfill.
  const showList = live.length > 1;

  const qualityStyles = (rating?: string | null) =>
    rating === 'GREEN'
      ? 'bg-emerald-500/15 text-emerald-500'
      : rating === 'YELLOW'
        ? 'bg-amber-500/15 text-amber-500'
        : rating === 'RED'
          ? 'bg-red-500/15 text-red-500'
          : 'bg-muted text-muted-foreground';

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      {/* Header: connection status (was the "Set up WhatsApp messaging"
          heading + subtext) on the left, Refresh button top-right. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`size-2.5 shrink-0 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`}
            aria-hidden
          />
          <h3 className="text-base font-bold text-foreground">
            {connected
              ? t('statusCard.statusConnected')
              : t('statusCard.statusNotConnected')}
          </h3>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="shrink-0"
        >
          {refreshing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {refreshing ? t('statusCard.refreshing') : t('statusCard.refresh')}
        </Button>
      </div>

      {/* Account details — ACTIVE number's business name + phone. */}
      <div className="mt-4 rounded-lg border border-border bg-background p-4">
        <p className="truncate text-base font-bold text-foreground">
          {businessName || t('statusCard.statusUnknown')}
        </p>
        <div className="my-3 border-t border-border" />
        <p className="flex items-center gap-2 text-sm text-foreground">
          <Phone className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{phoneNumber}</span>
        </p>
      </div>

      {/* Edge-case prompts from the catalog (migration 047). */}
      {numbers.length > 0 && live.length === 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-600/40 bg-amber-950/30 p-3 text-sm text-amber-200">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>{t('statusCard.noNumbersWarning')}</span>
        </div>
      )}
      {numbers.length > 0 && live.length > 0 && !hasActive && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-600/40 bg-amber-950/30 p-3 text-sm text-amber-200">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>{t('statusCard.activeMissingWarning')}</span>
        </div>
      )}

      {/* Every synced number under the WABA — shown when Meta lists
          more than one, so the active sending number can be switched
          in place. */}
      {showList && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('statusCard.numbersHeading')}
          </p>
          <ul className="mt-2 space-y-2">
            {live.map((n) => (
              <li
                key={n.phone_number_id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {n.display_phone_number || `ID ${n.phone_number_id}`}
                  </p>
                  <div className="flex items-center gap-2">
                    {n.verified_name && (
                      <p className="truncate text-xs text-muted-foreground">
                        {n.verified_name}
                      </p>
                    )}
                    {n.quality_rating && (
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${qualityStyles(n.quality_rating)}`}
                      >
                        {n.quality_rating}
                      </span>
                    )}
                  </div>
                </div>
                {n.is_active ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-emerald-500">
                    <CheckCircle2 className="size-3.5" />
                    {t('statusCard.activeBadge')}
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={!canSwitch || switchingId !== null}
                    onClick={() => onSetActive(n.phone_number_id)}
                  >
                    {switchingId === n.phone_number_id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : null}
                    {switchingId === n.phone_number_id
                      ? t('statusCard.settingActive')
                      : t('statusCard.setActive')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Disconnect lives on the card — the only place a connected
          account should offer it (the legacy Reset button below stays
          wired to its own DELETE flow). */}
      <div className="mt-4 flex justify-end">
        <Button
          variant="destructive"
          size="sm"
          onClick={onDisconnect}
          disabled={disconnecting}
        >
          {disconnecting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          {disconnecting ? t('disconnect.disconnecting') : t('disconnect.button')}
        </Button>
      </div>
    </div>
  );
}
