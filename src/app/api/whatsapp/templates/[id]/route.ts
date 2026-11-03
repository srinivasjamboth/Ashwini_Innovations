import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isNumericMetaId } from '@/lib/whatsapp/waba-pairing'
import {
  deleteMessageTemplate,
  editMessageTemplate,
  isTemplateGoneOnMeta,
} from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { validateCarouselSubmission } from '@/lib/whatsapp/carousel'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureMediaHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { ensureCarouselCardHandles } from '@/lib/whatsapp/carousel-card-handle'

/**
 * Per-template lifecycle endpoint.
 *
 * PATCH  — edit an existing Meta-side template (and re-submit). Used
 *          by the "Edit" action on APPROVED rows and the "Resubmit"
 *          action on REJECTED / PAUSED rows. Meta replaces components
 *          wholesale on edit and bumps status back to PENDING.
 *
 * DELETE — drop the local row, always, and remove the template on Meta
 *          first when it is still there (scoped to a single language
 *          variant via hsm_id). A Meta refusal no longer blocks the
 *          local delete: it is reported back as `meta_warning` so the UI
 *          can say the row is gone from the CRM but may still exist in
 *          WhatsApp Manager until the next Sync reconciles it.
 *
 * Initial submission (DRAFT → PENDING) lives at the sibling
 * /submit endpoint — keep this route narrowly about lifecycle of
 * already-submitted templates.
 *
 * Both handlers require 'admin' (GHSA-m4fx-g6pr-hrw8): message
 * templates are settings-class data, and the Meta call happens before
 * the local mutation, so the admin-only message_templates_update /
 * _delete RLS policies were no backstop at all — a viewer or agent got
 * the remote edit or delete through and only the local write bounced.
 */

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED'])

// uuid v4 plus the looser shape Postgres gen_random_uuid emits.
// We don't need exhaustive RFC parsing — just enough to reject
// "../etc/passwd"-style payloads before they hit Supabase.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  )
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid template id.' },
        { status: 400 },
      )
    }
    // Editing a template pushes a component replacement to Meta before
    // anything is written locally, so the role has to be checked here.
    const { supabase, accountId } = await requireRole('admin')

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    // RLS handles ownership, but we need the existing row to read
    // meta_template_id and status — fetch explicitly.
    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id, name, status, meta_template_id, language')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 })
    }

    if (!existing.meta_template_id) {
      return NextResponse.json(
        {
          error:
            'This template was never submitted to Meta — use New Template to submit it instead.',
        },
        { status: 400 },
      )
    }

    if (!EDITABLE_STATUSES.has(existing.status)) {
      return NextResponse.json(
        {
          error: `Templates in status ${existing.status} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED.`,
        },
        { status: 400 },
      )
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not editable here — manage them in Meta WhatsApp Manager.',
        },
        { status: 400 },
      )
    }

    try {
      validateTemplatePayload(payload)
      validateCarouselSubmission(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 },
      )
    }

    if (!isDryRun()) {
      const { data: config, error: configError } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .single()
      if (configError || !config) {
        return NextResponse.json(
          { error: 'WhatsApp not configured.' },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.access_token)

      // Media headers (image/video/document) need a fresh Resumable-Upload
      // handle on every edit (Meta replaces components wholesale). Derive
      // from header_media_url.
      try {
        await ensureMediaHeaderHandle(payload, accessToken)
        // Same rule per card on a carousel template.
        await ensureCarouselCardHandles(payload, accessToken)
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Header media upload failed.' },
          { status: 400 },
        )
      }

      const metaPayload = buildMetaTemplatePayload(payload)
      try {
        await editMessageTemplate({
          metaTemplateId: existing.meta_template_id,
          accessToken,
          components: metaPayload.components,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta edit failed.'
        await supabase
          .from('message_templates')
          .update({
            submission_error: message,
            last_submitted_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('account_id', accountId)
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    // Meta accepted the edit — status flips back to PENDING for review.
    const { data: row, error: updErr } = await supabase
      .from('message_templates')
      .update({
        category: payload.category,
        header_type: payload.header_type ?? null,
        header_content: payload.header_content ?? null,
        header_media_url: payload.header_media_url ?? null,
        header_handle: payload.header_handle ?? null,
        body_text: payload.body_text,
        footer_text: payload.footer_text ?? null,
        buttons: payload.buttons ?? null,
        sample_values: payload.sample_values ?? null,
        carousel: payload.header_type === 'carousel' ? (payload.carousel ?? null) : null,
        status: 'PENDING',
        submission_error: null,
        rejection_reason: null,
        last_submitted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', accountId)
      .select()
      .single()

    if (updErr) {
      return NextResponse.json(
        {
          error: `Edited on Meta but failed to save locally: ${updErr.message}. Run "Sync from Meta" to recover.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: isDryRun(),
    })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error editing template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to edit template.',
      },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid template id.' },
        { status: 400 },
      )
    }
    // Deleting removes the template on Meta first; same reasoning as
    // the PATCH handler above.
    const { supabase, accountId } = await requireRole('admin')

    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id, name, meta_template_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 })
    }

    // Meta requires a numeric `hsm_id`. A row submitted while
    // WHATSAPP_TEMPLATES_DRY_RUN was on carries a synthetic
    // `dry-run-<uuid>` instead, which can never resolve on Meta — and
    // since DRY_RUN is an env flag that can be turned off later, sending
    // it would strand the row permanently. Treat those as local-only rows.
    const deletableOnMeta =
      !!existing.meta_template_id && isNumericMetaId(existing.meta_template_id)

    /**
     * Set when the Meta side could not be cleaned up and the template is
     * still live there. The local row is removed either way — a template
     * the user cannot delete is a dead end — and the caller tells the user
     * why, so "Sync from Meta" bringing it back is explained, not
     * mysterious.
     */
    let metaWarning: string | null = null

    if (deletableOnMeta && !isDryRun()) {
      const { data: config, error: configError } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .single()
      if (configError || !config || !config.waba_id) {
        // Nothing to delete remotely, and no way to check. Warn rather
        // than block: the local row still goes.
        metaWarning = 'WhatsApp not configured — the template was not checked on Meta.'
      } else {
        const accessToken = decrypt(config.access_token)
        try {
          await deleteMessageTemplate({
            wabaId: config.waba_id,
            accessToken,
            name: existing.name,
            metaTemplateId: existing.meta_template_id,
          })
        } catch (e) {
          // Meta answers a template it has already dropped with
          // "(#100) Invalid parameter", identical to a genuinely malformed
          // request, so ask Meta directly whether the id still exists
          // before treating this as a failed cleanup.
          const gone = await isTemplateGoneOnMeta({
            metaTemplateId: existing.meta_template_id,
            accessToken,
          })
          if (!gone) {
            metaWarning = e instanceof Error ? e.message : 'Meta delete failed.'
          }
        }
      }
    }

    const { error: delErr } = await supabase
      .from('message_templates')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (delErr) {
      return NextResponse.json(
        {
          error: `Deleted on Meta but failed to delete locally: ${delErr.message}.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      dry_run: isDryRun(),
      meta_warning: metaWarning,
    })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error deleting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to delete template.',
      },
      { status: 500 },
    )
  }
}
