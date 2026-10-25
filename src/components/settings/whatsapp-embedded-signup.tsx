'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

// Minimal shape of the parts of the Facebook JS SDK we touch. The real
// global is untyped and only exists once connect.facebook.net/sdk.js has
// loaded, so everything is optional and guarded at runtime.
interface FbLoginResponse {
  authResponse?: { code?: string; accessToken?: string };
}
interface FacebookSdk {
  init: (opts: Record<string, unknown>) => void;
  login: (cb: (r: FbLoginResponse) => void, opts: Record<string, unknown>) => void;
}

// Loaded once per page and cached — FB.init must not run twice, and the
// SDK script tag should only ever be inserted once. Reset to null on a
// load failure so a retry (e.g. after a flaky network) can try again.
let fbSdkPromise: Promise<FacebookSdk> | null = null;

function loadFacebookSdk(appId: string): Promise<FacebookSdk> {
  if (fbSdkPromise) return fbSdkPromise;
  fbSdkPromise = new Promise<FacebookSdk>((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('no-window'));
      return;
    }
    const w = window as unknown as { FB?: FacebookSdk; fbAsyncInit?: () => void };
    const initAndResolve = () => {
      const FB = w.FB;
      if (!FB) {
        reject(new Error('fb-missing'));
        return;
      }
      // autoLogAppEvents + xfbml mirror Meta's reference snippet. The
      // Graph `version` only matters if the SDK made the API calls for
      // us — here we talk to Graph ourselves from the server — but it
      // must be a version the SDK recognises, so keep it current.
      FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: 'v21.0' });
      resolve(FB);
    };
    if (w.FB) {
      initAndResolve();
      return;
    }
    const prevInit = w.fbAsyncInit;
    w.fbAsyncInit = () => {
      prevInit?.();
      initAndResolve();
    };
    if (!document.getElementById('fb-jssdk')) {
      const script = document.createElement('script');
      script.id = 'fb-jssdk';
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.onerror = () => {
        fbSdkPromise = null;
        reject(new Error('fb-load-failed'));
      };
      document.body.appendChild(script);
    }
  });
  return fbSdkPromise;
}

interface SignupResult {
  code: string;
  phone_number_id: string | null;
  waba_id: string | null;
}

interface WabaNumberOption {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  /** WABA that owns this number — the picker can span sibling WABAs
   *  of the portfolio, and POST /config validates the pair together. */
  waba_id?: string;
}

/**
 * Drive the client half of Embedded Signup: load + init the FB SDK, open
 * the Meta popup with FB.login, and resolve once we hold BOTH the
 * exchangeable `code` (from the login callback) and the customer asset
 * ids (`phone_number_id` / `waba_id`, which Meta surfaces in a
 * `WA_EMBEDDED_SIGNUP` `FINISH` postMessage rather than in the callback).
 *
 * Rejects with sentinel strings the caller maps to localised messages:
 * 'cancelled' (user closed the popup without finishing), 'no-assets'
 * (code came back but Meta never reported the WhatsApp ids), 'timeout'.
 */
function runEmbeddedSignup(appId: string, configId: string): Promise<SignupResult> {
  return loadFacebookSdk(appId).then(
    (FB) =>
      new Promise<SignupResult>((resolve, reject) => {
        let code: string | null = null;
        let assets: { phone_number_id?: string; waba_id?: string } | null = null;
        let settled = false;

        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(guard);
          window.removeEventListener('message', onMessage);
          fn();
        };

        const maybeFinish = () => {
          // Accept a WABA-only finish too — that is what Meta sends when
          // the customer connected an account whose numbers were already
          // registered (no new number was created in the flow). The
          // caller then lists and picks from those numbers.
          if (code && assets && (assets.phone_number_id || assets.waba_id)) {
            settle(() =>
              resolve({
                code: code as string,
                phone_number_id: assets?.phone_number_id ?? null,
                waba_id: assets?.waba_id ?? null,
              }),
            );
          }
        };

        const onMessage = (event: MessageEvent) => {
          if (typeof event.origin === 'string' && !event.origin.endsWith('facebook.com')) {
            return;
          }
          try {
            const data = JSON.parse(event.data);
            if (
              data &&
              data.type === 'WA_EMBEDDED_SIGNUP' &&
              data.event === 'FINISH' &&
              data.data
            ) {
              assets = data.data;
              maybeFinish();
            }
          } catch {
            // Non-JSON message events are unrelated traffic on the window.
          }
        };

        // Overall safety net — the popup may sit open indefinitely.
        const guard = window.setTimeout(() => settle(() => reject(new Error('timeout'))), 150000);

        window.addEventListener('message', onMessage);

        FB.login(
          (response) => {
            const returnedCode = response?.authResponse?.code;
            if (!returnedCode) {
              settle(() => reject(new Error('cancelled')));
              return;
            }
            code = returnedCode;
            maybeFinish();
            // Code TTL is ~30s. If Meta didn't follow the callback with a
            // FINISH message shortly, the flow didn't complete as expected;
            // fail with a clear reason instead of waiting out the guard.
            window.setTimeout(() => {
              if (!settled && code && !assets?.phone_number_id && !assets?.waba_id) {
                settle(() => reject(new Error('no-assets')));
              }
            }, 4000);
          },
          {
            config_id: configId,
            response_type: 'code',
            override_default_response_type: true,
            // business_management is NOT optional: without it the
            // exchanged token cannot call /me/businesses, so numbers
            // verified under OTHER WABAs / portfolios of the same
            // business stay invisible after connect. Meta's Embedded
            // Signup docs list exactly these scopes.
            scope: 'whatsapp_business_management whatsapp_business_messaging business_management',
            extras: {
              featureType: 'whatsapp_embedded_signup',
              sessionInfoVersion: '3',
              setup: {},
            },
          },
        );
      }),
  );
}

/**
 * The "Connect with Meta" card. Renders ONLY when both
 * NEXT_PUBLIC_META_APP_ID and NEXT_PUBLIC_WHATSAPP_CONFIG_ID are set, so
 * deployments that haven't configured Embedded Signup keep the manual
 * form alone.
 *
 * It never writes the config itself — it hands the exchanged credentials
 * to POST /api/whatsapp/config, the exact endpoint the manual form uses.
 * That is what makes the two paths converge on the same whatsapp_config
 * row and connected state, and what turns a Meta connect over an
 * existing manual config into an UPDATE (reconnect), not a duplicate.
 */
export function WhatsAppEmbeddedSignup({
  onConnected,
}: {
  onConnected: () => void | Promise<void>;
}) {
  const t = useTranslations('Settings.whatsapp');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when signup finished with a WABA but no specific number — the
  // user then picks one of the WABA's already-registered numbers.
  const [pendingNumbers, setPendingNumbers] = useState<{
    accessToken: string;
    wabaId: string;
    numbers: WabaNumberOption[];
  } | null>(null);

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const configId = process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
  const enabled = Boolean(appId && configId);

  /** Save through the SAME endpoint as manual configuration so the
   * verify / register / subscribe / encrypt / upsert logic (and the
   * resulting connected state) is identical for both paths. */
  const saveConnected = useCallback(
    async (phoneNumberId: string, wabaId: string | null, accessToken: string) => {
      const saveRes = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number_id: phoneNumberId,
          waba_id: wabaId,
          access_token: accessToken,
        }),
      });
      const saved = await saveRes.json();
      if (!saveRes.ok) {
        throw new Error(saved.error || t('metaConnectFailed'));
      }
      toast.success(
        saved.registered ? t('metaConnectSuccess') : t('savedRegistrationSkipped'),
        { duration: 8000 },
      );
      // POST /api/whatsapp/config now syncs EVERY number under the
      // WABA into the catalog (migration 047). Tell the user when the
      // session number was not the only one — they switch the active
      // sender on the status card that appears right after refetch.
      const syncedCount = Array.isArray(saved.phone_numbers)
        ? saved.phone_numbers.filter((n: { removed_at?: string | null }) => !n.removed_at).length
        : 0;
      if (saved.phone_numbers_empty) {
        toast.warning(t('metaConnectNoNumbers'), { duration: 10000 });
      } else if (syncedCount > 1) {
        toast.info(t('metaConnectMultipleNumbers', { count: syncedCount }), {
          duration: 10000,
        });
      }
      await onConnected();
    },
    [t, onConnected],
  );

  const handlePickNumber = useCallback(
    async (option: WabaNumberOption) => {
      if (!pendingNumbers) return;
      setError(null);
      setConnecting(true);
      try {
        // Save the number with ITS OWN waba_id — the list can include
        // numbers from sibling WABAs the session didn't land on.
        await saveConnected(
          option.id,
          option.waba_id ?? pendingNumbers.wabaId,
          pendingNumbers.accessToken,
        );
        setPendingNumbers(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('metaConnectFailed'));
      } finally {
        setConnecting(false);
      }
    },
    [pendingNumbers, saveConnected, t],
  );

  const handleConnect = useCallback(async () => {
    if (!appId || !configId) {
      setError(t('metaConnectNotConfigured'));
      return;
    }
    setError(null);
    setPendingNumbers(null);
    setConnecting(true);
    try {
      const result = await runEmbeddedSignup(appId, configId);

      // 1) Exchange the short-lived code for a business token server-side.
      const cbRes = await fetch('/api/whatsapp/embedded-signup/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: result.code,
          phone_number_id: result.phone_number_id,
          waba_id: result.waba_id,
        }),
      });
      const cb = await cbRes.json();
      if (!cbRes.ok || !cb.access_token) {
        throw new Error(cb.error || t('metaConnectFailed'));
      }

      // Meta answered which permissions the token carries. Without
      // business_management the server cannot enumerate the customer's
      // other portfolios, so previously verified numbers under sibling
      // WABAs will not appear — say so up front instead of letting the
      // user wonder whether the connect "worked".
      if (Array.isArray(cb.granted_scopes) && cb.granted_scopes.length > 0) {
        console.log('[embedded-signup] granted scopes:', cb.granted_scopes.join(', '));
        if (!cb.granted_scopes.includes('business_management')) {
          toast.warning(t('metaScopeMissing'), { duration: 12000 });
        }
      }

      // 2a) Fresh-number path — Meta reported a concrete phone number.
      if (cb.phone_number_id) {
        await saveConnected(cb.phone_number_id, cb.waba_id ?? null, cb.access_token);
        return;
      }

      // 2b) Existing-number path — only a WABA came back; the server
      // listed its registered numbers, let the user choose one.
      if (cb.waba_id && Array.isArray(cb.phone_numbers) && cb.phone_numbers.length > 0) {
        setPendingNumbers({
          accessToken: cb.access_token,
          wabaId: cb.waba_id,
          numbers: cb.phone_numbers,
        });
        return;
      }

      setError(t('metaConnectNoAssets'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'cancelled') {
        setError(t('metaConnectCancelled'));
      } else if (msg === 'no-assets') {
        setError(t('metaConnectNoAssets'));
      } else {
        setError(msg || t('metaConnectFailed'));
        toast.error(t('metaConnectFailed'), { duration: 10000 });
      }
    } finally {
      setConnecting(false);
    }
  }, [appId, configId, saveConnected, t]);

  if (!enabled) return null;

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardHeader>
        <span className="inline-flex w-fit items-center rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
          {t('metaConnectRecommendedBadge')}
        </span>
        <CardTitle className="text-foreground">{t('metaConnectRecommended')}</CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('metaConnectRecommendedDesc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          onClick={handleConnect}
          disabled={connecting}
          className="w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
        >
          {connecting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t('metaConnectWorking')}
            </>
          ) : (
            <>
              <ExternalLink className="size-4" />
              {t('metaConnectButton')}
            </>
          )}
        </Button>
        {pendingNumbers && (
          <div className="space-y-2 rounded-lg border bg-background p-3">
            <p className="text-sm font-medium">
              Select which WhatsApp number to connect:
            </p>
            {pendingNumbers.numbers.map((n) => (
              <Button
                key={n.id}
                type="button"
                variant="outline"
                className="w-full justify-start text-left"
                disabled={connecting}
                onClick={() => handlePickNumber(n)}
              >
                {n.verified_name ? `${n.verified_name} — ` : ''}
                {n.display_phone_number || `ID ${n.id}`}
              </Button>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </CardContent>
    </Card>
  );
}
