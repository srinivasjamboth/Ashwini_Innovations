import { describe, expect, it } from 'vitest';

import {
  META_BILLING_BASE_URL,
  buildMetaBillingUrl,
} from '@/lib/whatsapp/billing-link';

describe('buildMetaBillingUrl', () => {
  it('scopes to the portfolio with business_id when known', () => {
    const url = buildMetaBillingUrl({ businessId: '1234567890' });
    expect(url).toBe(
      'https://business.facebook.com/billing_hub/accounts/?business_id=1234567890'
    );
  });

  it('falls back to the base Billing Hub URL without a portfolio id', () => {
    expect(buildMetaBillingUrl({ businessId: null })).toBe(
      META_BILLING_BASE_URL
    );
    expect(buildMetaBillingUrl({ businessId: '' })).toBe(META_BILLING_BASE_URL);
  });

  it('ignores a non-numeric portfolio id instead of pasting it into a URL', () => {
    // Meta ids are digit strings; a corrupted/stored value must never
    // reach Meta as a query parameter (open-redirect / injection guard).
    expect(
      buildMetaBillingUrl({ businessId: 'https://evil.example/x' })
    ).toBe(META_BILLING_BASE_URL);
    expect(buildMetaBillingUrl({ businessId: '12 34' })).toBe(
      META_BILLING_BASE_URL
    );
  });

  it('never puts the WABA id into the URL', () => {
    // Billing Hub is portfolio-level; asset_id is not part of the
    // verified pattern (see the helper header).
    const url = buildMetaBillingUrl({
      businessId: '42',
      wabaId: '9876543210',
    });
    expect(url).not.toContain('asset_id');
    expect(url).not.toContain('9876543210');
    expect(url).toContain('business_id=42');
  });

  it('carries no secrets or tokens in the URL', () => {
    const url = buildMetaBillingUrl({ businessId: '42', wabaId: '7' });
    expect(url).not.toMatch(/access_token|secret|tk=/i);
  });
});
