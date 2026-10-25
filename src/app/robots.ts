import type { MetadataRoute } from 'next';

/**
 * robots.txt — did not exist before the Super Admin Dashboard.
 *
 * Created with exactly one rule so the admin area is disallowed at
 * the crawler level (matching its X-Robots-Tag noindex and the fact
 * that nothing on the public site links to it). Every other path
 * keeps the pre-existing "no robots file ⇒ allow-all" behavior —
 * nothing here changes how legitimate client routes are crawled.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: ['/ashwini-control'],
      },
    ],
  };
}
