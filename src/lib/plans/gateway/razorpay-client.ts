/**
 * Razorpay CHECKOUT.JS loader — the client-side half of the gateway.
 *
 * Kept separate from `./razorpay` on purpose: that module reads server
 * secrets and imports `node:crypto`, and pulling it into a browser bundle
 * would either fail to build or (worse) risk shipping secret material. This
 * file has no env access at all — it only knows the public CDN URL and how
 * to open the payment sheet.
 *
 * Two flows live here:
 *   · `openRazorpaySubscription` — the LEGACY Subscriptions-model sheet, kept
 *     untouched so any existing recurring customer still works.
 *   · `openRazorpayOrder` — the current Orders-model sheet (UPI-ready) used by
 *     every Subscribe / Upgrade / Switch / Renew button. The order is created
 *     server-side from the STORED price, so the client can only ever authorize
 *     what the server returned. Activation is STILL the verified signature +
 *     gateway confirmation (or the webhook), never this file's job.
 */

export const RAZORPAY_CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

/** Brand color for the checkout sheet header. Razorpay needs a hex; the app's
 *  own themes are oklch, so we ship one stable brand hex rather than trying to
 *  convert a runtime CSS variable. Presentation only — no pricing/plan data. */
export const CHECKOUT_THEME_COLOR = "#2f80ed";
export const CHECKOUT_MERCHANT_NAME = "Ashwini Innovations";
export const CHECKOUT_LOGO_SRC = "/logo.jpeg";

export interface RazorpaySubscriptionResult {
  razorpay_payment_id?: string;
  razorpay_subscription_id?: string;
  razorpay_payment_link_id?: string;
}

/** What checkout.js hands the JS success handler for an ORDER payment. The
 *  signature is verified server-side (never here) before anything activates. */
export interface RazorpayOrderResult {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

export type RazorpayOrderOutcome =
  | { status: "success"; result: RazorpayOrderResult }
  | { status: "cancelled" };

interface RazorpayCheckoutOptions {
  key: string;
  subscription_id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  name?: string;
  description?: string;
  image?: string;
  notes?: Record<string, string>;
  theme?: { color?: string; backdrop_color?: string };
  timeout?: number;
  callback_url?: string;
  prefill?: { name?: string; email?: string; contact?: string };
  handler?: (res: RazorpayOrderResult & RazorpaySubscriptionResult) => void;
  modal?: { ondismiss?: () => void; backdropclose?: boolean; confirm_close?: boolean };
  method?: { card?: boolean; upi?: boolean; netbanking?: boolean; wallet?: boolean };
  config?: Record<string, unknown>;
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

/**
 * Open Razorpay's ORDERS sheet (UPI-ready) for the order the server just
 * created (spec PART 4). Resolves:
 *   · { status: "success", result }  — the JS handler fired with the payment
 *     trio (desktop inline completion). The caller verifies + activates.
 *   · { status: "cancelled" }        — the buyer dismissed the sheet. Money may
 *     or may not have moved; the caller checks the true status, never assumes.
 *
 * A redirect / UPI-intent flow (mobile, in-app webviews) leaves the page and
 * comes back through `callbackUrl`; there the handler cannot fire, so the
 * caller relies on the status poll / the callback route. That is why both a
 * `callbackUrl` and the JS handler are supported at once.
 *
 * Rejects only when the SDK itself cannot load — the caller maps that apart
 * from a cancellation so "gateway down" and "user changed their mind" read
 * differently.
 */
export async function openRazorpayOrder(args: {
  keyId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  description?: string;
  image?: string;
  prefill?: RazorpayCheckoutOptions["prefill"];
  notes?: Record<string, string>;
  themeColor?: string;
  timeoutSeconds?: number;
  callbackUrl?: string;
}): Promise<RazorpayOrderOutcome> {
  const ready = await loadRazorpayCheckout();
  const Checkout = ready ? window.Razorpay : undefined;
  if (!Checkout) throw new Error("checkout_unavailable");

  return new Promise<RazorpayOrderOutcome>((resolve, reject) => {
    let settled = false;
    const instance = new Checkout({
      key: args.keyId,
      order_id: args.orderId,
      // checkout.js wants the amount in the smallest unit (paise). It is
      // redundant next to order_id but keeps the sheet correct if the order
      // frame needs it, and is never a client-chosen figure.
      amount: args.amountPaise,
      currency: args.currency,
      name: CHECKOUT_MERCHANT_NAME,
      description: args.description,
      image: args.image ?? CHECKOUT_LOGO_SRC,
      notes: args.notes,
      theme: { color: args.themeColor ?? CHECKOUT_THEME_COLOR },
      // ~10 minutes: a UPI intent that takes a moment to approve should not
      // have the sheet yanked out from under the payer.
      timeout: args.timeoutSeconds ?? 600,
      // Mobile / redirect / in-app browsers complete out-of-page and come
      // back here; on desktop the handler below usually fires first.
      callback_url: args.callbackUrl,
      // Keep every method available but lead with UPI (spec: UPI-first
      // display config, cards / netbanking / wallets still offered). This is
      // Razorpay's current `config.display` block schema.
      config: {
        display: {
          blocks: {
            upi: { name: "UPI", instruments: ["upi"] },
            card: { name: "Card", instruments: ["card", "emi"] },
            netbanking: { name: "Netbanking", instruments: ["netbanking"] },
            wallet: { name: "Wallet", instruments: ["wallet"] },
          },
          sequence: ["block:upi", "block:card", "block:netbanking", "block:wallet"],
        },
      },
      prefill: args.prefill,
      handler: (res) => {
        settled = true;
        resolve({
          status: "success",
          result: {
            razorpay_payment_id: res.razorpay_payment_id,
            razorpay_order_id: res.razorpay_order_id,
            razorpay_signature: res.razorpay_signature,
          },
        });
      },
      modal: {
        backdropclose: false,
        confirm_close: true,
        ondismiss: () => {
          if (!settled) resolve({ status: "cancelled" });
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
