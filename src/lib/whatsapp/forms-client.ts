/**
 * Client-side reads for WhatsApp Forms/Flows.
 *
 * Kept as plain async helpers rather than hooks: the two consumers (the
 * Forms list page and the Template Builder's Form dropdown) refresh on
 * different triggers — a mutation on one, a panel closing on the other —
 * and a shared fetch function is enough to keep the response shape in one
 * place.
 */

import type { PublishedFlowOption, WhatsAppFlow } from '@/types';

export async function fetchWhatsAppFlows(): Promise<WhatsAppFlow[]> {
  const res = await fetch('/api/whatsapp-flows');
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { flows?: WhatsAppFlow[] };
  return body.flows ?? [];
}

/**
 * Published Flows only — the shape a template's Form button needs.
 *
 * Throws on failure rather than returning `[]`: an empty dropdown and an
 * unreadable dropdown are different problems for the user, and the second
 * one must not look like "you haven't created any forms yet".
 */
export async function fetchPublishedFlows(): Promise<PublishedFlowOption[]> {
  const res = await fetch('/api/whatsapp-flows/published');
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { flows?: PublishedFlowOption[] };
  return body.flows ?? [];
}

/** Server error text when present, otherwise a status-shaped fallback. */
async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (typeof body?.error === 'string' && body.error) return body.error;
  return `Request failed (${res.status})`;
}
