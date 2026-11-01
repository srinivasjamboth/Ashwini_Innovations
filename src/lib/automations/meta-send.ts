import { sendTextMessage, sendTemplateMessage, sendFlowMessage } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
} from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { assertConversationInAccount } from '@/lib/whatsapp/conversation-scope'
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body'
import {
  buildSendTemplateSnapshot,
  isMissingColumnError,
} from '@/lib/whatsapp/template-render'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  /** Legacy body-only values. */
  params?: string[]
  /**
   * Structured send-time values (body / header / button params). When the
   * account has a local copy of the template, these build the full
   * `components` array so header-text and URL-button variables actually
   * reach Meta — the legacy `params` path is body-only.
   */
  messageParams?: SendTimeParams
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

/**
 * Send an image / video / document / audio via a public URL from the
 * automation engine.
 *
 * Delegates to the Flows engine's `engineSendMedia`, which already owns
 * the account-scoped lookup, phone-variant retry, and the `messages`
 * insert (`content_type` = media kind, `sender_type='bot'`) — same
 * one-implementation rationale as `engineSendInteractive` above.
 */
export { engineSendMedia }

interface SendFlowArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  /** Meta's flow name (`whatsapp_flows.meta_flow_id`). */
  name: string
  firstScreenId?: string
  bodyText: string
}

/**
 * Send an interactive FLOW message (WhatsApp Form) from the automation
 * engine. Resolves the recipient + credentials exactly like
 * `sendViaMeta` (account-scoped, service-role), then persists the sent
 * message so the inbox thread shows the form prompt.
 */
export async function engineSendFlow(
  args: SendFlowArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error('contact not found for this account')
  }

  // Same GHSA-m4fx-g6pr-hrw8 defense as every other send path: the
  // engine runs with the service-role client, so re-verify the
  // conversation's tenant before inserting a message keyed on it.
  await assertConversationInAccount(db, args.conversationId, args.accountId)

  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) {
    throw new Error(
      `contact has no usable WhatsApp address (phone: ${contact.phone || 'none'})`
    )
  }
  const sanitized = sendTarget.target

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendFlowMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      name: args.name,
      firstScreenId: args.firstScreenId,
      bodyText: args.bodyText,
    })
    return r.messageId
  }

  // Same phone-variant retry as the text/template path above.
  const variants = sendTarget.isPhone ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (sendTarget.isPhone && workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // 'interactive' is in the content_type CHECK since migration 010. We
  // store no interactive_payload — the flow's rendered card lives on
  // Meta's side; the text preview is enough for the thread.
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: args.bodyText,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.bodyText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  return { whatsapp_message_id: waMessageId }
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error('contact not found for this account')
  }

  // Same for the conversation the message lands in — see
  // conversation-scope.ts (GHSA-m4fx-g6pr-hrw8).
  await assertConversationInAccount(db, input.conversationId, input.accountId)

  // Phone number, or the business-scoped user ID when Meta has never
  // given us a number for this customer (issue #519).
  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) {
    throw new Error(
      `contact has no usable WhatsApp address (phone: ${contact.phone || 'none'})`
    )
  }
  const sanitized = sendTarget.target

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // Local template row — read for the body we persist below, not for
  // the Meta payload (the wire shape is deliberately unchanged here).
  // A missing row is fine: the send still goes out, we just can't
  // reconstruct the text the customer saw.
  const templateRow =
    input.kind === 'template'
      ? (
          await resolveTemplateRow(
            db,
            input.accountId,
            input.templateName,
            input.language,
          )
        ).row
      : null

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        // Structured path when we have the row: buildSendComponents then
        // emits header + body + button components. Falls back to the
        // legacy body-only `params` when no local row exists.
        template: templateRow ?? undefined,
        messageParams: input.messageParams,
        params: input.params,
      })
      return r.messageId
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    })
    return r.messageId
  }

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message.
  const variants = sendTarget.isPhone ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (sendTarget.isPhone && workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Persist the sent message so it appears in the inbox with a real
  // Meta message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  // Templates persist the substituted body, same as the manual and
  // public-API send paths. This was unconditionally null, so every
  // automation template send rendered as an empty bubble (issue #483).
  const content_text =
    input.kind === 'text'
      ? input.text
      : templateContentText(templateRow, input.params ?? [])
  const template_name = input.kind === 'template' ? input.templateName : null

  // Snapshot of the whole delivery (header / body / footer / buttons)
  // so the inbox thread can render what the customer received. Null when
  // no local row resolved — nothing is stored, and the bubble keeps its
  // existing text-only fallback (it can still reconstruct later, once
  // the template is synced).
  const templatePayload =
    input.kind === 'template'
      ? buildSendTemplateSnapshot({
          template: templateRow,
          name: input.templateName,
          language: input.language,
          bodyParams: input.params,
          storedBody: content_text,
        })
      : null

  // `Record<string, unknown>` for the same reason as the manual send path:
  // the row is inserted either bare or with `template_payload` spread on,
  // and supabase-js' untyped insert helper rejects that union.
  const messageRow: Record<string, unknown> = {
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    template_name,
    message_id: waMessageId,
    status: 'sent',
  }

  const { error: firstErr } = await db.from('messages').insert(
    templatePayload
      ? { ...messageRow, template_payload: templatePayload }
      : messageRow
  )
  let msgErr = firstErr
  if (
    firstErr &&
    templatePayload &&
    isMissingColumnError(firstErr, 'template_payload')
  ) {
    // Migration 053 has not run here. Meta already delivered, so drop
    // the snapshot rather than lose the message from the thread.
    console.warn(
      '[automations] messages.template_payload is unavailable — storing this send without its snapshot (apply migration 053)'
    )
    const retry = await db.from('messages').insert(messageRow)
    msgErr = retry.error
  }
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template'
          ? (content_text ?? `[template:${input.templateName}]`)
          : input.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)

  return { whatsapp_message_id: waMessageId }
}
