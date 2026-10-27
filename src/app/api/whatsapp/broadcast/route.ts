import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import { resolveTemplateRow, templateBodyParams, templateContentText } from '@/lib/whatsapp/template-body'
import { buildSendTemplateSnapshot } from '@/lib/whatsapp/template-render'
import { mirrorBroadcastToChat } from '@/lib/whatsapp/broadcast-chat'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { checkLimit, incrementUsage } from '@/lib/plans/entitlements'

interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string
  /** Body variable values, one per {{N}}. Legacy field. */
  params?: string[]
  /**
   * Structured per-send values (header text variable, media URL
   * override, URL/COPY_CODE button values). When set, takes
   * precedence over `params` for the body too — see
   * sendTemplateMessage for the merge rules.
   */
  messageParams?: SendTimeParams
}

/** Bound the per-request fan-out wall-clock on serverless hosts. */
export const maxDuration = 60

/** Wall-clock sleep used only for per-recipient pacing. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(request: Request) {
  try {
    // Requires the 'agent' role — `canSendMessages` in lib/auth/roles is
    // explicit that running broadcasts is a write operation and that
    // viewers are read-only.
    //
    // This endpoint writes NOTHING to the database: it reads the config
    // and template, then calls Meta directly. So unlike the rest of the
    // app there was no RLS policy backstopping a missing role check —
    // resolving `account_id` straight off the profile (which only needs
    // 'viewer') was the ONLY gate, and it let a viewer blast a template
    // to arbitrary phone numbers from the account's WhatsApp number.
    // Nothing about that is recoverable after the fact, so the check has
    // to happen here.
    const { supabase, accountId, userId } = await requireRole('agent')

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      delay_ms,
    } = body

    // Per-recipient pacing (ms), clamped to the migration-051 range.
    const rawDelay = typeof delay_ms === 'number' ? Math.floor(delay_ms) : 0
    const pacingMs = Number.isFinite(rawDelay)
      ? Math.min(60_000, Math.max(0, rawDelay))
      : 0

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    // Plan enforcement (Part 4): a broadcast send is the bulk-message quota.
    // Pre-check the WHOLE batch against remaining capacity and reject the
    // entire operation (not just the overflow) if it would exceed the plan.
    // Enterprise is unlimited (-1), so checkLimit never blocks it — the fair-
    // use flag is recorded on increment below. Deletions never restore quota.
    const bulk = await checkLimit(accountId, 'bulk_messages', recipients.length)
    if (!bulk.allowed) {
      return NextResponse.json(bulk, { status: 403 })
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Load the template row once so sendTemplateMessage can build
    // header + button components on each iteration. Loading inside
    // the loop would N+1 against Supabase for every recipient.
    // Guard against a malformed local row crashing every send in
    // the loop with the same opaque TypeError — fail loudly once.
    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      template_name,
      template_language,
    )
    if (resolvedTemplate.malformed) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        },
        { status: 500 },
      )
    }
    const templateRow = resolvedTemplate.row

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (let rIdx = 0; rIdx < recipients.length; rIdx++) {
      const recipient = recipients[rIdx]
      const sanitized = sanitizePhoneForMeta(recipient.phone)

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        })
        failedCount++
        continue
      }

      // Retry with phone variants on "not in allowed list" so numbers
      // that differ only in a trunk-prefix 0 still reach recipients.
      const variants = phoneVariants(sanitized)
      let sentMessageId: string | null = null
      let lastError: string | null = null

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: template_name,
            language: resolvedTemplate.language,
            template: templateRow ?? undefined,
            messageParams: recipient.messageParams,
            params: recipient.params ?? [],
          })
          sentMessageId = result.messageId
          lastError = null
          break
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error'
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage
            break
          }
          lastError = errorMessage
          // retry with next variant
        }
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        })
        sentCount++
        // Body + full-delivery snapshot for this recipient. Computed
        // once so the mirror's `content_text` and its `template_payload`
        // cannot disagree about what was sent.
        const bodyParams = templateBodyParams(
          recipient.params,
          recipient.messageParams,
        )
        const contentText = templateContentText(templateRow, bodyParams)
        // Mirror the delivered template into the recipient's chat thread
        // so the broadcast is visible in the Inbox (find-or-create on
        // the dedupe keys — never a duplicate number or conversation,
        // and best-effort: a mirror failure never fails the send).
        await mirrorBroadcastToChat(supabase, {
          accountId,
          userId,
          phone: sanitized,
          templateName: template_name,
          contentText,
          templatePayload: buildSendTemplateSnapshot({
            template: templateRow,
            name: template_name,
            language: resolvedTemplate.language,
            messageParams: recipient.messageParams,
            bodyParams,
            storedBody: contentText,
          }),
          whatsappMessageId: sentMessageId,
        })
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          lastError
        )
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        })
        failedCount++
      }

      // Pacing: space sends so a multi-recipient request never bursts
      // past Meta's messaging rate (130429). Skipped after the last
      // recipient and whenever no delay is configured. A paced send-now
      // arrives as one recipient per request (browser-side sleep), so
      // this only fires for callers that post a batch with delay_ms.
      if (pacingMs > 0 && rIdx < recipients.length - 1) {
        await sleep(pacingMs)
      }
    }

    // Record the messages ACTUALLY sent (Part 4: "increment by the number
    // actually sent"), not the batch size — failures don't consume quota.
    if (sentCount > 0) {
      await incrementUsage(accountId, 'bulk_messages', sentCount)
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp broadcast POST:', error)
    return toErrorResponse(error)
  }
}
