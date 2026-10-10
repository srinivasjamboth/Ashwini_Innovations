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
          if (code && assets?.phone_number_id) {
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
              if (!settled && code && !assets?.phone_number_id) {
                settle(() => reject(new Error('no-assets')));
              }
            }, 4000);
          },
          {
            config_id: configId,
            response_type: 'code',
            override_default_response_type: true,
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

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const configId = process.env.NEXT_PUBLIC_WHATSAPP_CONFIG_ID;
  const enabled = Boolean(appId && configId);

  const handleConnect = useCallback(async () => {
    if (!appId || !configId) {
      setError(t('metaConnectNotConfigured'));
      return;
    }
    setError(null);
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
      if (!cb.phone_number_id) {
        setError(t('metaConnectNoAssets'));
        return;
      }

      // 2) Save through the SAME endpoint as manual configuration so the
      //    verify / register / subscribe / encrypt / upsert logic (and the
      //    resulting connected state) is identical for both paths.
      const saveRes = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number_id: cb.phone_number_id,
          waba_id: cb.waba_id ?? null,
          access_token: cb.access_token,
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
      await onConnected();
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
  }, [appId, configId, onConnected, t]);

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
        {error && <p className="text-sm text-red-500">{error}</p>}
      </CardContent>
    </Card>
  );
}
