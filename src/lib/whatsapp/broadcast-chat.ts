// ============================================================
// Broadcast → Inbox mirror.
//
// A broadcast template send used to live only in `broadcast_recipients`
// — the Inbox never saw it, so replying customers appeared out of
// nowhere and the team had no thread proving a number was messaged.
// This helper mirrors every SUCCESSFUL broadcast delivery into the
// chat surface, reusing the exact same tenancy rules as every other
// write path so nothing duplicates:
//
//   contact      → the shared last-8-digit dedupe lookup (dedupe.ts),
//                  DB backstop UNIQUE (account_id, phone_normalized)
//                  from migration 022, race re-resolve like the webhook.
//   conversation → one per (account, contact), oldest-first, DB
//                  backstop UNIQUE (account_id, contact_id) from
//                  migration 036 — never a second thread per number.
//   message      → upsert idempotent on UNIQUE (conversation_id,
//                  message_id) from migration 037, so a Meta retry or
//                  a broadcast resume can never land the same wamid
//                  twice. Real wamid stored ⇒ the webhook's status
//                  handler keeps flipping it sent → delivered → read.
//
// Mirroring is strictly best-effort: it NEVER throws, because the
// template has already reached the customer by the time we run — a
// chat-bookkeeping failure must not abort or fail the send loop.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { isMissingColumnError } from '@/lib/whatsapp/template-render';
import type { TemplateMessagePayload } from '@/types';

export interface BroadcastChatMirrorArgs {
  accountId: string;
  /** Audit owner for rows created here (contact / conversation). */
  userId: string;
  /** Number the template actually went to (any format — normalized). */
  phone: string;
  /** Known contact id (broadcast recipients almost always have one) — skips the lookup. */
  contactId?: string | null;
  templateName: string;
  /** Substituted body the recipient saw. Null falls back to a [template:…] label. */
  contentText: string | null;
  /**
   * The complete delivery (header, body, footer, buttons) as sent to
   * this recipient, so the thread shows what they received. Optional and
   * additive: a caller that passes nothing keeps the old text-only
   * mirror, and a row from before migration 053 renders the same way it
   * does today.
   */
  templatePayload?: TemplateMessagePayload | null;
  /** Meta's message id for the delivered template. */
  whatsappMessageId: string;
}

export async function mirrorBroadcastToChat(
  db: SupabaseClient,
  args: BroadcastChatMirrorArgs,
): Promise<void> {
  try {
    await mirrorInner(db, args);
  } catch (err) {
    // The send itself succeeded — never bubble a chat-mirror failure
    // into the delivery loop.
    console.error('[broadcast-chat] mirror failed:', err);
  }
}

async function mirrorInner(
  db: SupabaseClient,
  args: BroadcastChatMirrorArgs,
): Promise<void> {
  const digits = normalizePhone(args.phone);
  if (!digits || !args.whatsappMessageId) return;

  // ---- contact (find, or create exactly once) ----------------------
  let contactId: string | null = null;

  if (args.contactId) {
    // Trust but scope: an id from a stale plan must belong to this
    // account before we hang a conversation on it.
    const { data } = await db
      .from('contacts')
      .select('id')
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
      .maybeSingle();
    contactId = data?.id ?? null;
  }

  if (!contactId) {
    const existing = await findExistingContact(db, args.accountId, digits);
    contactId = existing?.id ?? null;
  }

  if (!contactId) {
    const { data: created, error } = await db
      .from('contacts')
      .insert({
        account_id: args.accountId,
        user_id: args.userId,
        phone: `+${digits}`,
        name: null,
      })
      .select('id')
      .maybeSingle();

    if (created?.id) {
      contactId = created.id as string;
    } else if (isUniqueViolation(error)) {
      // Raced with the webhook / another concurrent pass — adopt the
      // winner instead of compounding duplicates.
      const raced = await findExistingContact(db, args.accountId, digits);
      contactId = raced?.id ?? null;
    }
  }
  if (!contactId) return;

  // ---- conversation (one per account+contact, oldest-first) --------
  const findConversation = async (): Promise<string | null> => {
    const { data } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', args.accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1);
    return data?.[0]?.id ?? null;
  };

  let conversationId = await findConversation();
  if (!conversationId) {
    const { data: conv, error: convErr } = await db
      .from('conversations')
      .insert({
        account_id: args.accountId,
        user_id: args.userId,
        contact_id: contactId,
      })
      .select('id')
      .maybeSingle();
    if (conv?.id) {
      conversationId = conv.id as string;
    } else if (isUniqueViolation(convErr)) {
      conversationId = await findConversation();
    }
  }
  if (!conversationId) return;

  // ---- message (idempotent on the wamid) ----------------------------
  // sender_type 'agent' + content_type 'template' is the same shape the
  // inbox composer's own template sends persist, so the thread renders
  // it identically.
  const messageRow = {
    conversation_id: conversationId,
    sender_type: 'agent',
    content_type: 'template',
    content_text: args.contentText,
    template_name: args.templateName,
    message_id: args.whatsappMessageId,
    status: 'sent',
  };
  const payload = args.templatePayload ?? null;

  const write = (row: Record<string, unknown>) =>
    db
      .from('messages')
      .upsert(row, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true });

  const { error: msgErr } = await write(
    payload ? { ...messageRow, template_payload: payload } : messageRow
  );
  if (msgErr && isMissingColumnError(msgErr, 'template_payload')) {
    // Migration 053 has not run on this database. The template already
    // reached the customer, so mirror it without the snapshot instead of
    // losing the message from the thread.
    console.warn(
      '[broadcast-chat] messages.template_payload is unavailable — mirroring without the snapshot (apply migration 053)'
    );
    const retry = await write(messageRow);
    if (retry.error) {
      console.error('[broadcast-chat] message upsert failed:', retry.error.message);
      return;
    }
  } else if (msgErr) {
    console.error('[broadcast-chat] message upsert failed:', msgErr.message);
    return;
  }

  // ---- surface the chat at the top of the inbox list ----------------
  const preview = args.contentText?.trim() || `[template:${args.templateName}]`;
  const { error: convUpdErr } = await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
  if (convUpdErr) {
    console.error(
      '[broadcast-chat] conversation preview update failed:',
      convUpdErr.message,
    );
  }
}
