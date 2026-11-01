# Subscriptions & Razorpay Checkout — Setup Guide

The **Subscribe** flow opens Razorpay Checkout (UPI-ready) for Monthly and
Yearly plans. After a successful payment the plan is activated automatically —
through the browser verify handshake, the `order.paid` webhook, the mobile /
UPI-intent redirect callback, or a reconciliation job — all routed through one
idempotent activation so the period is extended **exactly once**.

This document is the operator checklist. Everything plan-related (plans, prices
in rupees, limits, yearly figures) lives in the database; the environment only
connects the payment gateway.

---

## OWNER SETUP CHECKLIST

1. **Create API keys** in the Razorpay dashboard — one **Test** key pair and,
   later, one **Live** key pair (`Settings → API Keys → Generate Key`).
2. **Enable the payment methods** you want — at minimum **UPI**
   (`Settings → Account Settings → Payment Gateway Settings → UPI`), plus
   cards / netbanking / wallets as desired.
3. **Set the webhook URL** to
   `https://<your-domain>/api/webhooks/razorpay`
   subscribed to the **`order.paid`** and **`payment.failed`** events, and
   give it a **webhook secret** (Razorpay → Webhooks → New → add the secret it
   shows you).
4. **Turn on Automatic Capture** (`Settings → Account Settings → Payment
   Gateway Settings → Enable auto-capture`). Without it, an authorised card
   payment stays `authorized` until the server captures it; the flow handles
   that, but auto-capture is the recommended, simpler setting.
5. **Complete Live-mode activation** with Razorpay (KYC / live credentials
   enabled) before using the Live key pair.
6. **Add the values to the deployment environment** (see below), test first,
   then live.

---

## Environment variables

Copy the shapes from `.env.local.example`. The billing block is fully
documented there; the five relevant variables are:

| Variable | Scope | Notes |
| --- | --- | --- |
| `RAZORPAY_KEY_ID` | public / browser | checkout.js `key`. Safe to expose. |
| `RAZORPAY_KEY_SECRET` | **server only** | Verifies the checkout signature + calls the Orders API. Never returned to the client. |
| `RAZORPAY_WEBHOOK_SECRET` | **server only** | Verifies `X-Razorpay-Signature` on `/api/webhooks/razorpay`. Without it every webhook is rejected. |
| `RAZORPAY_API_BASE` | optional | Override only for a proxy/mock. |
| `YEARLY_BILLING_ENABLED` | optional | `false` hides the Monthly/Yearly toggle everywhere (pre-yearly behaviour). Default on. |

**Test vs live is just a different key pair** — set one pair per deployment
environment (e.g. Vercel Preview = test keys, Production = live keys).

A startup check (`src/lib/plans/gateway/config-check.ts`) logs a clear warning
naming any missing value. It **never logs a secret value**. The secret has been
verified absent from the production client bundle.

---

## Apply the database migration

The Orders flow adds two tables additively (existing payment/subscription
tables are reused unchanged):

- `payment_orders` — one row per checkout (plan snapshot, cycle, amount in
  rupees, `razorpay_order_id` unique, `razorpay_payment_id` unique nullable,
  status, method, failure reason, fulfilment timestamps).
- `razorpay_webhook_events` — processed event ids for de-duplication.

This project applies SQL through the **Supabase SQL Editor** using the combined
idempotent `supabase/apply_now.sql` (it has `DROP … IF EXISTS` / `IF NOT EXISTS`
guards, so re-running is safe). Run that file — or apply
`supabase/migrations/054_billing_orders.sql` on its own. As of writing, the
pending migrations include `044`, `045`, `046`, `048`, `049`, `052`, `054`.

---

## Reconciliation cron

The Orders flow needs a periodic reconciler for missed webhooks / closed
browser windows: every ~10 minutes it re-checks `created` / `attempted` orders
older than 5 minutes and younger than 24 hours against Razorpay and activates
any that are paid.

- Route: `GET /api/billing/cron` (accepts `Authorization: Bearer <CRON_SECRET>`,
  matching the broadcast cron).
- Scheduled in `vercel.json`. On self-hosted/Docker, hit the same URL from your
  own scheduler on the same interval.

---

## What "verified" means (security model)

- The client sends **only** `{ plan_key, billing_cycle }`. The price is read
  from the database; the amount, currency and plan are **never** taken from the
  browser.
- A plan activates **only** on a server-verified signature **plus** a Razorpay
  API confirmation, **or** a verified webhook, **or** the signature-verified
  redirect callback — all funnelling through the single idempotent
  `fulfillPaidOrder`.
- Every endpoint is tenant-scoped by account; a bad/tampered signature activates
  nothing. Order creation and verify are rate-limited. The webhook reads the
  **raw** body before parsing (required for signature verification).

---

## Billing tab & receipts

Settings → **Billing** shows the current plan, renewal/expiry date, usage, the
**"What's included in your plan"** list rendered the same way as the landing
pricing cards, and the payment history (date, plan, cycle, amount, method,
status, payment id). After a redirect / UPI-intent payment the tab reads the
`?checkout=` status, confirms, and refreshes the plan with no reload.

---

## Known flags / limitations

- **No auto-renewal.** Customers renew by paying again; this version does not
  create Razorpay recurring subscriptions.
- **GST is not applied.** Prices are charged exactly as listed. Adding a tax
  rate / invoices is a separate task (the intended tax rate config defaults to
  `0`).
- **Refunds are manual** in the Razorpay dashboard and do **not** automatically
  revoke a plan.
- **Amounts are integers in paise at the gateway boundary**; everything stored
  and displayed is rupees (`NUMERIC(12,2)`), converted ×100 only when talking to
  Razorpay.
- **Test mode covers UPI test ids only** (`success@razorpay`,
  `failure@razorpay`). UPI **intent** and **QR** are available only in **live**
  mode, so the owner must complete one small **live UPI payment** (e.g. Starter
  monthly) on the deployed site, confirm activation, then refund it from the
  Razorpay dashboard.

---

## Legacy customers (Subscriptions model)

Existing Razorpay **recurring subscription** customers are protected: the legacy
subscription code paths are untouched, their payment history is merged into the
billing tab, and a one-off Order payment cancels any prior legacy recurring
subscription on activation so nobody is double-charged.
