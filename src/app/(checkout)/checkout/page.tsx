'use client';

// ============================================================
// Public checkout / billing page — `/checkout?plan=<id>&cycle=<monthly|yearly>`.
//
// This is what a "Subscribe" click opens when the visitor is NOT on the
// pricing page: middle-click, "open in new tab", a shared link, a no-JS
// visit and the post-login redirect all land here. The pricing section's own
// Subscribe button now opens the same billing UI inside a scroll-animated
// panel on the spot (components/plans/checkout-scroll-overlay.tsx), so this
// route stays the canonical, URL-addressable version of that panel.
//
// The page is only the chrome: the minimal (checkout) layout's brand header,
// its own container, and the "Back to pricing" link. Every billing figure,
// the cycle fallback rule, the pay flow and the auth reveal live in
// <CheckoutPanel> — one copy shared with the scroller, so the number shown
// here is the number that will be charged and enforced, in both surfaces.
// ============================================================

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { CheckoutPanel } from '@/components/plans/checkout-panel';

export default function CheckoutPage() {
  // Reading `?plan=&cycle=` opts this out of static prerender unless it sits
  // under Suspense — the same split the login / signup pages use.
  return (
    <Suspense
      fallback={
        <div className="container-xxl px-lg-5 px-4 py-5">
          <div
            className="bg-light rounded"
            style={{ height: 320, maxWidth: 720, margin: '0 auto' }}
          />
        </div>
      }
    >
      <CheckoutInner />
    </Suspense>
  );
}

function CheckoutInner() {
  const searchParams = useSearchParams();

  const planParam = searchParams.get('plan');
  const cycleParam =
    searchParams.get('cycle') === 'yearly' ? 'yearly' : 'monthly';

  return (
    <div className="container-xxl px-lg-5 px-4 py-5" style={{ maxWidth: 1080 }}>
      <Link
        href="/#pricing"
        className="d-inline-flex align-items-center text-decoration-none text-muted mb-4 gap-2"
        style={{ fontSize: 14 }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m12 19-7-7 7-7" />
          <path d="M19 12H5" />
        </svg>
        Back to pricing
      </Link>

      <CheckoutPanel planId={planParam} cycle={cycleParam} stickySummary />
    </div>
  );
}
