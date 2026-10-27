/**
 * Razorpay CHECKOUT.JS loader — the client-side half of the gateway.
 *
 * Kept separate from `./razorpay` on purpose: that module reads server
 * secrets and imports `node:crypto`, and pulling it into a browser bundle
 * would either fail to build or (worse) risk shipping secret material. This
 * file has no env access at all — it only knows the public CDN URL and how
 * to open the subscription payment sheet.
 *
 * The subscription itself is created server-side from the STORED gateway plan
 * for the chosen cycle, so the client can only ever authorize what checkout
 * returned. Activation is still the webhook's job, never this file's.
 */

export const RAZORPAY_CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

export interface RazorpaySubscriptionResult {
  razorpay_payment_id?: string;
  razorpay_subscription_id?: string;
  razorpay_payment_link_id?: string;
}

interface RazorpayCheckoutOptions {
  key: string;
  subscription_id: string;
  theme?: { backdrop_color?: string };
  prefill?: { name?: string; email?: string; contact?: string };
  handler?: (res: RazorpaySubscriptionResult) => void;
  modal?: { ondismiss?: () => void };
  method?: { card?: boolean; upi?: boolean; netbanking?: boolean; wallet?: boolean };
}

interface RazorpayCheckout {
  open(): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => RazorpayCheckout;
  }
}

/** Inject checkout.js once, reuse the same script tag on every open. */
export function loadRazorpayCheckout(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);

  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${RAZORPAY_CHECKOUT_SCRIPT}"]`,
  );
  if (existing) {
    return new Promise((resolve) => {
      if (window.Razorpay) return resolve(true);
      existing.addEventListener("load", () => resolve(Boolean(window.Razorpay)));
      existing.addEventListener("error", () => resolve(false));
    });
  }

  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = RAZORPAY_CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

/**
 * Open Razorpay's payment sheet for a subscription the server already
 * created. Resolves with the gateway payment id on success, `null` when the
 * buyer closes the sheet, and rejects only when the SDK itself is
 * unavailable — so the caller can tell "user changed their mind" apart from
 * "the gateway is broken".
 */
export async function openRazorpaySubscription(args: {
  keyId: string;
  subscriptionId: string;
  prefill?: RazorpayCheckoutOptions["prefill"];
}): Promise<RazorpaySubscriptionResult | null> {
  const ready = await loadRazorpayCheckout();
  const Checkout = ready ? window.Razorpay : undefined;
  if (!Checkout) throw new Error("checkout_unavailable");

  return new Promise<RazorpaySubscriptionResult | null>((resolve, reject) => {
    let settled = false;
    const instance = new Checkout({
      key: args.keyId,
      subscription_id: args.subscriptionId,
      theme: { backdrop_color: "#333333" },
      prefill: args.prefill,
      handler: (res) => {
        settled = true;
        resolve(res);
      },
      modal: {
        ondismiss: () => {
          if (!settled) resolve(null);
        },
      },
    });
    try {
      instance.open();
    } catch (err) {
      if (!settled) reject(err instanceof Error ? err : new Error("checkout_failed"));
    }
  });
}
