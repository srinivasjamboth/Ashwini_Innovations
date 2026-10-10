/**
 * WhatsApp Flows (Forms) — server-side business logic.
 *
 * Split out from the route handlers the same way `broadcast-core.ts` and
 * `template-webhook.ts` are: the routes own status codes and request
 * shape, this file owns tenancy, Meta's API, and the local row. Two
 * routes (create + delete) need the WABA credential dance, and it is
 * exactly the part that must not drift between them.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  buildFlowsUrl,
  type PlaygroundLink,
} from '@/lib/whatsapp/flow-playground';
import {
  createFlow,
  deleteFlow,
  getFlowFields,
  type FlowCategory,
} from '@/lib/whatsapp/meta-api';
import {
  describeFlowValidationErrors,
  inspectFlowJson,
  type FlowJsonIssue,
} from '@/lib/whatsapp/flow-json';
import type { WhatsAppFlow, WhatsAppFlowStatus } from '@/types';

/** Thrown when the caller's account cannot reach Meta at all. */
export class WhatsAppNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppNotConfiguredError';
  }
}

/** Thrown when the submitted Flow JSON fails our structural pre-check. */
export class FlowJsonRejectedError extends Error {
  readonly issue: FlowJsonIssue;
  constructor(issue: FlowJsonIssue, message: string) {
    super(message);
    this.name = 'FlowJsonRejectedError';
    this.issue = issue;
  }
}

/**
 * Meta finished the Flow but could not publish it (validator errors), or
 * refused outright. The row is persisted with status='error' so the UI
 * can show *why* — this is not a silent success.
 */
export class MetaRejectedFlowError extends Error {
  readonly flow: WhatsAppFlow;
  constructor(message: string, flow: WhatsAppFlow) {
    super(message);
    this.name = 'MetaRejectedFlowError';
    this.flow = flow;
  }
}

const FLOW_SELECT =
  'id, account_id, created_by, meta_flow_id, name, status, screens_count, error_message, created_at, updated_at';

/**
 * Load the account's WABA id + plaintext token.
 *
 * Deliberately NOT cached and NOT the service-role client: `supabase` is
 * the RLS-scoped SSR client from `requireRole`, so a caller who is not a
 * member of `accountId` reads zero rows here rather than someone else's
 * token. The two failure messages are what the Settings page can act on,
 * so they stay distinct.
 */
export async function loadAccountWaba(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{ wabaId: string; accessToken: string }> {
  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('waba_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle();

  if (!config?.access_token) {
    throw new WhatsAppNotConfiguredError(
      'WhatsApp not connected. Connect your WhatsApp Business account in Settings → WhatsApp first.',
    );
  }
  if (!config.waba_id) {
    throw new WhatsAppNotConfiguredError(
      'WABA (WhatsApp Business Account) ID is missing from your connection. Re-connect your account in Settings → WhatsApp.',
    );
  }
  return { wabaId: config.waba_id, accessToken: decrypt(config.access_token) };
}

/**
 * WABA id only, and never throws.
 *
 * `loadAccountWaba` is the write-path helper: no connection is a fatal
 * error there. The Playground link degrades instead — it still works
 * without a connection, it just cannot name which account to pick.
 */
export async function readAccountWabaId(
  supabase: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('waba_id')
    .eq('account_id', accountId)
    .maybeSingle();
  return config?.waba_id ?? null;
}

/**
 * Build the Playground link for this account.
 *
 * It lands on the Flows page (`/wa/manage/flows/`), not the WhatsApp
 * Manager overview, and carries `?waba_id=` — the account-scoping
 * parameter Meta documents for that page.
 *
 * It is *not* reported as fully scoped, and that is deliberate: the
 * companion parameter in Meta's own examples is `business_id`, a Business
 * Manager portfolio id this app never captures (the connection stores
 * `waba_id` and `phone_number_id` only), and putting a WABA id in the
 * `business_id` slot would silently open some other business rather than
 * fail loudly. So the panel still names the WABA to select — the link gets
 * you to the right tool, the instruction gets you to the right account.
 */
export async function resolvePlaygroundLink(
  supabase: SupabaseClient,
  accountId: string,
): Promise<PlaygroundLink> {
  const wabaId = await readAccountWabaId(supabase, accountId);
  return { url: buildFlowsUrl(wabaId), scoped: false, wabaId };
}

/**
 * Collapse Meta's status vocabulary into our column.
 *
 * Only PUBLISHED is selectable by a template's Form button, so anything
 * else — DRAFT, DEPRECATED, BLOCKED, THROTTLED, or a status newer than
 * this code — maps to 'draft'. Defaulting to 'draft' on an unknown value
 * is the safe direction: it hides a Flow from the dropdown rather than
 * offering one that Meta will refuse to send.
 */
export function mapMetaStatus(raw: unknown): WhatsAppFlowStatus {
  return typeof raw === 'string' && raw.toUpperCase() === 'PUBLISHED'
    ? 'published'
    : 'draft';
}

export interface CreateWhatsAppFlowArgs {
  supabase: SupabaseClient;
  accountId: string;
  userId: string;
  name: string;
  /** Raw text from the panel's textarea — validated, then re-serialised. */
  flowJsonText: string;
  categories?: FlowCategory[];
}

/**
 * Validate → create on Meta → publish → persist.
 *
 * Order matters for the failure modes:
 *   * A structural reject throws *before* any Graph call, so a typo never
 *     becomes a rate-limited Meta request.
 *   * Once Meta has minted a Flow we always write a local row — even on
 *     rejection — because `meta_flow_id` is the only handle to inspect or
 *     clean up what Meta created. Losing it would strand a DRAFT on the
 *     customer's WABA.
 *   * The stored status comes from a read-back of Meta's own view, not
 *     from what we asked for. `publish: true` is a request, not a
 *     guarantee: if the JSON has validator errors Meta keeps the Flow in
 *     DRAFT, and claiming 'published' would put a button in the Templates
 *     builder that fails on send.
 */
export async function createWhatsAppFlow(
  args: CreateWhatsAppFlowArgs,
): Promise<WhatsAppFlow> {
  const { supabase, accountId, userId, name, flowJsonText } = args;

  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new FlowJsonRejectedError('empty', 'Form name is required.');
  }

  const check = inspectFlowJson(flowJsonText);
  if (!check.ok) {
    throw new FlowJsonRejectedError(
      check.issue ?? 'invalidJson',
      'Flow JSON did not pass the structural check.',
    );
  }

  const { wabaId, accessToken } = await loadAccountWaba(supabase, accountId);

  // Round-trip through JSON.parse/stringify so what Meta receives and
  // what we store are the same normalised document (the textarea may
  // carry trailing whitespace or duplicate keys).
  const normalisedJson = JSON.stringify(JSON.parse(flowJsonText));

  const meta = await createFlow({
    wabaId,
    accessToken,
    name: trimmedName,
    categories: args.categories ?? ['OTHER'],
    flowJson: normalisedJson,
    publish: true,
  });

  const rejectionMessage = describeFlowValidationErrors(meta.validationErrors);

  // No id at all → nothing exists on Meta's side and nothing to remember.
  if (!meta.metaFlowId) {
    const message = rejectionMessage ?? 'Meta did not return a Flow id for this create.';
    const row = await persistFlowRow(supabase, accountId, userId, {
      name: trimmedName,
      metaFlowId: null,
      flowJson: normalisedJson,
      screensCount: check.screensCount,
      status: 'error',
      errorMessage: message,
    });
    throw new MetaRejectedFlowError(message, row);
  }

  // Ask Meta what it actually ended up with. A read-back failure is not
  // fatal — the Flow exists — so we fall back to 'draft' (safe: excluded
  // from the published-only dropdown) rather than guessing 'published'.
  let status: WhatsAppFlowStatus = 'draft';
  try {
    const fields = await getFlowFields({ metaFlowId: meta.metaFlowId, accessToken });
    status = mapMetaStatus(fields.status);
  } catch {
    status = 'draft';
  }

  if (rejectionMessage) status = 'error';
  const publishedClean = status === 'published' && !rejectionMessage;

  const row = await persistFlowRow(supabase, accountId, userId, {
    name: trimmedName,
    metaFlowId: meta.metaFlowId,
    flowJson: normalisedJson,
    screensCount: check.screensCount,
    status,
    errorMessage: publishedClean ? null : (rejectionMessage ?? 'Meta created the Flow but did not publish it.'),
  });

  if (!publishedClean) {
    throw new MetaRejectedFlowError(
      row.error_message ?? 'Meta rejected the Flow.',
      row,
    );
  }

  return row;
}

async function persistFlowRow(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  values: {
    name: string;
    metaFlowId: string | null;
    flowJson: string;
    screensCount: number;
    status: WhatsAppFlowStatus;
    errorMessage: string | null;
  },
): Promise<WhatsAppFlow> {
  // `flow_json` is a jsonb column: hand Supabase the parsed document and
  // the driver stores it as JSON rather than as a quoted string.
  const parsedFlowJson = JSON.parse(values.flowJson);

  const { data, error } = await supabase
    .from('whatsapp_flows')
    .insert({
      account_id: accountId,
      created_by: userId,
      meta_flow_id: values.metaFlowId,
      name: values.name,
      status: values.status,
      flow_json: parsedFlowJson,
      screens_count: values.screensCount,
      error_message: values.errorMessage,
    })
    .select(FLOW_SELECT)
    .single();

  if (error) {
    throw new Error(
      `Flow was handled by Meta but could not be saved locally: ${error.message}`,
    );
  }
  return data as WhatsAppFlow;
}

/**
 * Delete a Form.
 *
 * Meta must go first when it can: a DRAFT left alive on the WABA while
 * our row is gone is invisible to this app forever. So a Meta failure
 * aborts the delete, and only a Meta 404 ("already gone") is treated as
 * success.
 *
 * A PUBLISHED Flow is removed locally only — Meta does not allow deleting
 * a published Flow (it can be deprecated in WhatsApp Manager, which is a
 * deliberate human action, not something a list-page trash icon should
 * do silently). Templates already carrying that button keep working,
 * because they reference Meta's id, not our row.
 */
export async function deleteWhatsAppFlow(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<void> {
  const { data: existing, error: readError } = await supabase
    .from('whatsapp_flows')
    .select('id, meta_flow_id, status')
    .eq('id', flowId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (readError) throw new Error(readError.message);
  if (!existing) {
    // Either never existed or belongs to another account — the same
    // answer to the caller, and we must not leak which.
    throw new Error('Form not found.');
  }

  if (existing.meta_flow_id && existing.status === 'draft') {
    // loadAccountWaba is asked for the whole connection even though the
    // delete needs only the token: a half-configured connection is a
    // failure here too, and refusing to delete locally-then-orphan the
    // Draft on Meta is the point.
    const { accessToken } = await loadAccountWaba(supabase, accountId);
    await deleteFlow({ metaFlowId: existing.meta_flow_id, accessToken });
  }

  const { error: deleteError } = await supabase
    .from('whatsapp_flows')
    .delete()
    .eq('id', flowId)
    .eq('account_id', accountId);

  if (deleteError) throw new Error(deleteError.message);
}

export { FLOW_SELECT, describeFlowValidationErrors, inspectFlowJson };
