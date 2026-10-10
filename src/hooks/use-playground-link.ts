'use client';

/**
 * The Meta Flow Builder link, fetched once per session.
 *
 * Two surfaces ask for it (the Forms list header and the Create Form
 * panel, which the Template Builder also embeds), and both must open the
 * *same* URL — a per-component fetch that disagrees with its sibling is
 * how a button ends up pointing at a different business. So the promise
 * is cached at module scope: the second mount reuses the first answer,
 * and a failure resolves to the generic link instead of leaving a dead
 * button behind.
 */

import { useEffect, useState } from 'react';
import {
  GENERIC_PLAYGROUND_LINK,
  type PlaygroundLink,
} from '@/lib/whatsapp/flow-playground';

let cached: Promise<PlaygroundLink> | null = null;

function loadPlaygroundLink(): Promise<PlaygroundLink> {
  if (!cached) {
    cached = fetch('/api/whatsapp-flows/playground-url')
      .then((res) => (res.ok ? res.json() : null))
      .then((body): PlaygroundLink => {
        if (!body || typeof body.url !== 'string' || !body.url) {
          return GENERIC_PLAYGROUND_LINK;
        }
        return {
          url: body.url,
          scoped: Boolean(body.scoped),
          wabaId: typeof body.wabaId === 'string' ? body.wabaId : null,
        };
      })
      .catch(() => {
        // Don't poison the cache with a failed lookup — the next mount
        // may well succeed (a cold-start network blip, for instance).
        cached = null;
        return GENERIC_PLAYGROUND_LINK;
      });
  }
  return cached;
}

export function usePlaygroundLink(): PlaygroundLink {
  const [link, setLink] = useState<PlaygroundLink>(GENERIC_PLAYGROUND_LINK);

  useEffect(() => {
    let mounted = true;
    loadPlaygroundLink().then((value) => {
      if (mounted) setLink(value);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return link;
}
