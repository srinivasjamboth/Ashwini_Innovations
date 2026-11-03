'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { normalizeKey } from '@/lib/contacts/dedupe';
import { getGroupNamesByIds, resolveGroupContactIds } from '@/lib/contacts/group-api';
import type { BroadcastCsvRow } from '@/lib/broadcast-csv';
import type { CarouselSendValues } from '@/lib/whatsapp/carousel';
import { Contact, MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'groups' | 'custom_field' | 'csv';
  tagIds?: string[];
  /**
   * Contact-group audience: members of ANY selected group, de-duped
   * server-side so an overlapping contact still gets exactly ONE
   * message. Recipients are frozen at create/schedule like every other
   * contact-list audience — later group edits never change a campaign
   * that already exists.
   */
  groupIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /**
   * Duplicate-preserving CSV rows (wizard keep-mode). When present the
   * CSV audience resolves per-ROW — every valid row becomes its own
   * recipient, repeats included — instead of the legacy per-unique-
   * contact `csvContacts` path. Contacts are still created at most once
   * per normalized number.
   */
  csvRows?: BroadcastCsvRow[];
  /** Display-only: name of the uploaded file, frozen on the campaign. */
  csvFileName?: string;
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * One recipient row of a campaign. A CSV-sourced entry exists per file
 * row (so the same contact can appear several times, each occurrence
 * carrying its own variable values); every other audience type produces
 * one entry per contact with `source: 'contact'`.
 */
export interface RecipientEntry {
  contact: Contact;
  source: 'contact' | 'csv';
  /** 1-based CSV line — stamped on broadcast_recipients.source_row. */
  sourceRow?: number;
  /** The file row behind a CSV entry (per-row variable values). */
  row?: BroadcastCsvRow;
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 *
 * Carousel campaigns additionally map card-scoped keys produced by
 * `carouselScopes` (`card.0.text.1`, `card.2.button.1.url`) in this
 * same record. The key spaces are disjoint — positional body params
 * only ever take the numeric keys — which is what lets a carousel
 * reuse the existing sources/fallbacks machinery untouched.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
  /**
   * Operator-chosen pacing (ms) between individual recipient sends, to
   * stay under Meta's messaging rate (130429). 0/undefined = today's
   * batched behaviour. Persisted on the broadcast row so a Resume and a
   * scheduled send pace identically. Range 0–60 000.
   */
  sendDelayMs?: number;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  /**
   * Resolve + freeze the audience exactly like the send-now path, then
   * persist a status 'scheduled' broadcast instead of sending it. The
   * scheduler cron fires it at `scheduledAt` server-side. Returns the
   * new broadcast id.
   */
  scheduleBroadcast: (
    payload: BroadcastPayload,
    scheduledAt: string,
    timezone: string,
  ) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/** `broadcast_recipients` inserts are independent of the send rate. */
const INSERT_BATCH_SIZE = 200;

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Resolve ONE mapping against a contact + its custom-field index. Body
 * placeholders and carousel card scopes share this — the spec's "every
 * scope uses the same sources" rule holds because both go through the
 * exact same resolver.
 */
function resolveMappingValue(
  v: VariableMapping,
  contact: Contact,
  customValues?: Map<string, string>,
): string {
  if (v.type === 'static') return v.value;

  if (v.type === 'field') {
    const fieldMap: Record<string, string | undefined> = {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      company: contact.company,
    };
    return fieldMap[v.value] ?? '';
  }

  // custom_field
  return customValues?.get(v.value) ?? '';
}

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 *
 * Only NUMERIC keys become positional body params — a carousel's
 * `card.*` keys live in the same record but resolve separately via
 * `resolveCarouselParams`, so campaigns from before carousels (and
 * every non-carousel campaign) produce an unchanged array.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}. Non-numeric keys (carousel scopes) drop out.
  const keys = Object.keys(variables)
    .filter((key) => Number.isFinite(Number(key)))
    .sort((a, b) => Number(a) - Number(b));

  return keys.map((key) => resolveMappingValue(variables[key], contact, customValues));
}

/** `card.<n>.text.<m>` — card index + 1-based variable position. */
const CARD_TEXT_KEY = /^card\.(\d+)\.text\.(\d+)$/;
/** `card.<n>.button.<b>.url` — card index + button index of a URL var. */
const CARD_URL_KEY = /^card\.(\d+)\.button\.(\d+)\.url$/;

/**
 * Carousel per-recipient values for one contact, in exactly the shape
 * `broadcast_recipients.carousel_params` freezes and
 * `parseCarouselSendValues` reads back on the server: text values
 * positional per card, URL-button values keyed by button index. Returns
 * `null` when no card-scoped key exists, so non-carousel broadcasts
 * write the column exactly as before (absent).
 */
export function resolveCarouselParams(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): CarouselSendValues | null {
  const cards: CarouselSendValues['cards'] = [];
  const ensureCard = (index: number): CarouselSendValues['cards'][number] => {
    while (cards.length <= index) cards.push({});
    return cards[index];
  };

  for (const [key, mapping] of Object.entries(variables)) {
    const textMatch = CARD_TEXT_KEY.exec(key);
    if (textMatch) {
      const card = ensureCard(Number(textMatch[1]));
      const varPos = Number(textMatch[2]);
      const texts = (card.text ??= []);
      while (texts.length < varPos) texts.push('');
      texts[varPos - 1] = resolveMappingValue(mapping, contact, customValues);
      continue;
    }
    const urlMatch = CARD_URL_KEY.exec(key);
    if (urlMatch) {
      const card = ensureCard(Number(urlMatch[1]));
      const value = resolveMappingValue(mapping, contact, customValues);
      if (value) (card.buttonUrls ??= {})[Number(urlMatch[2])] = value;
    }
  }

  return cards.length ? { cards } : null;
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  // Supabase PostgREST caps the .in(...) IN-clause roughly at 1000
  // values. Page through to stay safe.
  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  /**
   * Contact-list path: resolve the audience to distinct contacts, one
   * recipient entry each. The CSV keep-duplicates audience resolves
   * separately in `resolveCsvEntries` so the two semantics never leak.
   */
  async function resolveContactEntries(audience: AudienceConfig): Promise<RecipientEntry[]> {
    const supabase = createClient();

    let contacts: Contact[] = [];

    if (audience.type === 'all') {
      const { data, error } = await supabase.from('contacts').select('*');
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data ?? [];
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      const { data: contactTags, error: tagError } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.tagIds);

      if (tagError)
        throw new Error(`Failed to fetch contact tags: ${tagError.message}`);

      if (contactTags && contactTags.length > 0) {
        const uniqueContactIds = [
          ...new Set(contactTags.map((ct) => ct.contact_id)),
        ];
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .in('id', uniqueContactIds);
        if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
        contacts = data ?? [];
      }
    } else if (
      audience.type === 'groups' &&
      audience.groupIds &&
      audience.groupIds.length > 0
    ) {
      // resolve_group_contact_ids already de-dupes across overlapping
      // groups; page the contact fetch under the PostgREST IN cap.
      const groupMemberIds = await resolveGroupContactIds(
        supabase,
        audience.groupIds
      );
      if (groupMemberIds.length === 0) {
        throw new Error(
          'The selected contact groups have no members yet — add contacts to a group first.'
        );
      }
      for (let i = 0; i < groupMemberIds.length; i += 500) {
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .in('id', groupMemberIds.slice(i, i + 500));
        if (error)
          throw new Error(`Failed to fetch contacts: ${error.message}`);
        contacts.push(...((data ?? []) as Contact[]));
      }
    } else if (audience.type === 'custom_field' && audience.customField) {
      contacts = await resolveCustomFieldAudience(supabase, audience.customField);
    }

    // Apply exclude tags (works across all contact-derived audience
    // types). CSV rows are handled in the CSV path below.
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const { data: excludeRows } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.excludeTagIds);
      const excludedIds = new Set((excludeRows ?? []).map((r) => r.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    return contacts.map((contact) => ({ contact, source: 'contact' as const }));
  }

  /**
   * CSV keep-duplicates path: EVERY valid row becomes its own recipient
   * entry (a number listed three times sends three messages), while at
   * most ONE contact is created per normalized number — the first
   * occurrence's attributes win, later occurrences and pre-existing
   * contacts change nothing (upsert with ignoreDuplicates).
   */
  async function resolveCsvEntries(
    supabase: ReturnType<typeof createClient>,
    audience: AudienceConfig,
  ): Promise<{ entries: RecipientEntry[]; excludedRows: BroadcastCsvRow[] }> {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      throw new Error('You are not signed in.');
    }
    if (!accountId) {
      throw new Error('Your profile is not linked to an account.');
    }

    // Normalise input: the wizard's row-mode takes precedence; the
    // legacy {phone,name}[] shape is wrapped so old callers keep
    // working (they simply get no per-row extra values or line numbers).
    const inputRows: BroadcastCsvRow[] =
      audience.csvRows && audience.csvRows.length > 0
        ? audience.csvRows
        : (audience.csvContacts ?? []).map((c, i) => ({
            phone: c.phone,
            key: normalizeKey(c.phone),
            sourceRow: i + 2,
            name: c.name,
          }));

    if (inputRows.length === 0) return { entries: [], excludedRows: [] };

    // Contact creation is keyed on the first occurrence of each number.
    const firstByKey = new Map<string, BroadcastCsvRow>();
    for (const row of inputRows) {
      if (row.key && !firstByKey.has(row.key)) firstByKey.set(row.key, row);
    }
    const keys = [...firstByKey.keys()];

    // Single round-trip lookup of the contacts already in this ACCOUNT.
    // Scoping to `user_id` missed rows a teammate created on a shared
    // account, so those numbers looked new and their inserts collided
    // with the account-wide unique index.
    const { data: existing, error: lookupErr } = await supabase
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .in('phone_normalized', keys);
    if (lookupErr) {
      throw new Error(`Failed to look up CSV contacts: ${lookupErr.message}`);
    }

    const byKey = new Map<string, Contact>();
    for (const c of (existing ?? []) as Contact[]) {
      const key = normalizeKey(c.phone ?? '');
      if (key) byKey.set(key, c);
    }

    const missing = keys.filter((k) => !byKey.has(k));
    if (missing.length > 0) {
      // One contact per missing number, first occurrence's attributes.
      // `insert` died on a 23505 when a racing writer (another tab, a
      // concurrent Contacts import) claimed a number mid-flight; an
      // ignoreDuplicates upsert shrugs that off instead of failing the
      // whole broadcast.
      const newContacts = missing
        .map((k) => firstByKey.get(k)!)
        .map((row) => ({
          user_id: user.id,
          account_id: accountId,
          phone: row.phone,
          name: row.name ?? null,
        }));

      const INSERT_CHUNK = 200;
      for (let i = 0; i < newContacts.length; i += INSERT_CHUNK) {
        const batch = newContacts.slice(i, i + INSERT_CHUNK);
        const { error: upsertErr } = await supabase
          .from('contacts')
          .upsert(batch, {
            onConflict: 'account_id,phone_normalized',
            ignoreDuplicates: true,
          });
        if (upsertErr) {
          throw new Error(`Failed to create CSV contacts: ${upsertErr.message}`);
        }
      }

      // ignoreDuplicates returns no rows for a raced insert, and the
      // pre-race lookup below ran before the other writer landed — so
      // re-read anything still unresolved before giving up on it.
      const { data: reread } = await supabase
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .in('phone_normalized', missing);
      for (const c of (reread ?? []) as Contact[]) {
        const key = normalizeKey(c.phone ?? '');
        if (key) byKey.set(key, c);
      }
    }

    // CSV contacts are now real rows, so the exclusion list applies to
    // them too — reported as an explicit skip list the review can show,
    // not a silent drop.
    let excludedIds: Set<string> | null = null;
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const { data: excludeRows } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.excludeTagIds);
      excludedIds = new Set((excludeRows ?? []).map((r) => r.contact_id));
    }

    // Preserve input order so the campaign list roughly matches the CSV.
    const entries: RecipientEntry[] = [];
    const excludedRows: BroadcastCsvRow[] = [];
    for (const row of inputRows) {
      const contact = byKey.get(row.key);
      if (!contact) continue; // unsolvable number — skipped, never invented
      if (excludedIds?.has(contact.id)) {
        excludedRows.push(row);
        continue;
      }
      entries.push({ contact, source: 'csv', sourceRow: row.sourceRow, row });
    }

    return { entries, excludedRows };
  }

  async function resolveCustomFieldAudience(
    supabase: ReturnType<typeof createClient>,
    filter: CustomFieldFilter,
  ): Promise<Contact[]> {
    const { fieldId, operator, value } = filter;

    // Build the WHERE clause for the operator. PostgREST supports
    // eq/neq/ilike via the query builder — use ilike with wildcards
    // for "contains" so the match is case-insensitive.
    let query = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);

    if (operator === 'is') query = query.eq('value', value);
    else if (operator === 'is_not') query = query.neq('value', value);
    else if (operator === 'contains') query = query.ilike('value', `%${value}%`);

    const { data: matches, error: matchErr } = await query;
    if (matchErr)
      throw new Error(`Custom-field filter failed: ${matchErr.message}`);

    const contactIds = [...new Set((matches ?? []).map((m) => m.contact_id))];
    if (contactIds.length === 0) return [];

    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .in('id', contactIds);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    return data ?? [];
  }

  /**
   * Recipient entries for a payload across every audience type: the CSV
   * keep-duplicates path or the contact-list path. One call site for
   * both send-now and schedule, so a scheduled campaign freezes exactly
   * what an immediate one would have built.
   */
  async function resolveRecipients(audience: AudienceConfig): Promise<RecipientEntry[]> {
    if (audience.type === 'csv') {
      const supabase = createClient();
      const { entries } = await resolveCsvEntries(supabase, audience);
      return entries;
    }
    return resolveContactEntries(audience);
  }

  /**
   * Per-entry template params. A CSV entry's occurrence resolves
   * against ITS row's values — two rows with one number can greet the
   * same contact differently. Built-in fields fall back to the stored
   * contact for anything the row leaves blank; custom-field values
   * always come from the contact, since a CSV row carries none.
   */
  function paramsForEntry(
    payload: BroadcastPayload,
    entry: RecipientEntry,
    customValues: Map<string, string> | undefined,
  ): string[] {
    if (entry.source !== 'csv' || !entry.row) {
      return resolveVariables(payload.variables, entry.contact, customValues);
    }
    const row = entry.row;
    const pseudo: Contact = {
      ...entry.contact,
      name: row.name || entry.contact.name,
      email: row.email || entry.contact.email,
      company: row.company || entry.contact.company,
    };
    return resolveVariables(payload.variables, pseudo, customValues);
  }

  /**
   * Carousel card values for one entry — the exact same CSV-row
   * precedence `paramsForEntry` gives the body (the file row's name/
   * email/company override the stored contact), then the shared
   * card-scope resolver. `null` for every non-carousel campaign.
   */
  function carouselForEntry(
    payload: BroadcastPayload,
    entry: RecipientEntry,
    customValues: Map<string, string> | undefined,
  ): CarouselSendValues | null {
    if (entry.source !== 'csv' || !entry.row) {
      return resolveCarouselParams(payload.variables, entry.contact, customValues);
    }
    const row = entry.row;
    const pseudo: Contact = {
      ...entry.contact,
      name: row.name || entry.contact.name,
      email: row.email || entry.contact.email,
      company: row.company || entry.contact.company,
    };
    return resolveCarouselParams(payload.variables, pseudo, customValues);
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();
    // Operator pacing, clamped to the migration-051 range (0–60s).
    const rawDelay = payload.sendDelayMs ?? 0;
    const sendDelayMs = Number.isFinite(rawDelay)
      ? Math.min(60_000, Math.max(0, Math.floor(rawDelay)))
      : 0;

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('You are not signed in.');
      }
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience recipients ──────────────────
      setProgress(5);
      const entries = await resolveRecipients(payload.audience);

      if (entries.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(10);
      // Group names are frozen with the ids so the campaign stays
      // readable even after a group is renamed or deleted.
      const groupSnapshot =
        payload.audience.type === 'groups' &&
        payload.audience.groupIds &&
        payload.audience.groupIds.length > 0
          ? await getGroupNamesByIds(supabase, payload.audience.groupIds)
          : null;
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            // Groups audience: the ids behind the frozen recipients plus
            // their names at send time.
            ...(payload.audience.type === 'groups' && payload.audience.groupIds
              ? { groupIds: payload.audience.groupIds, groupNames: groupSnapshot ?? [] }
              : {}),
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
            // Frozen for the results page: which file produced this
            // campaign (row-mode CSV only).
            ...(payload.audience.type === 'csv' && payload.audience.csvFileName
              ? { csvFileName: payload.audience.csvFileName }
              : {}),
          },
          status: 'sending',
          total_recipients: entries.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
          send_delay_ms: sendDelayMs,
          // Media-header campaigns need this on every send. Persisted so
          // the server-driven delivery (and any later Resume) fires the
          // exact header the operator chose, matching the scheduled path.
          header_media_url: payload.headerMediaUrl?.trim() || null,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(
          `Failed to create broadcast: ${broadcastError?.message ?? 'unknown error'}`,
        );
      }

      // ── Step 3: Insert recipient rows ─────────────────────────────
      // Custom values are fetched BEFORE the insert so each row can
      // carry its resolved template params. Those params are what makes
      // the campaign resumable server-side (issue #472): delivery now
      // runs on the server, and the only record of what {{1}} should be
      // for each recipient is this column. Resolving once here also
      // means the resume sends exactly what this pass would have —
      // including CSV rows that repeat a number, which now get one
      // recipient row per occurrence with their own values.
      setProgress(20);
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        [...new Set(entries.map((e) => e.contact.id))],
      );
      const recipientRows = entries.map((entry) => {
        const carouselParams = carouselForEntry(
          payload,
          entry,
          customValueIndex.get(entry.contact.id),
        );
        return {
          broadcast_id: broadcast.id,
          contact_id: entry.contact.id,
          status: 'pending' as const,
          template_params: paramsForEntry(
            payload,
            entry,
            customValueIndex.get(entry.contact.id),
          ),
          source: entry.source,
          ...(entry.sourceRow != null ? { source_row: entry.sourceRow } : {}),
          // Frozen per-recipient card values (migration 059) — the only
          // record of what each card's variables were for this recipient,
          // read back by the server-side Resume.
          ...(carouselParams ? { carousel_params: carouselParams } : {}),
        };
      });

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          // Previous impl logged and marched on — the broadcast then ran
          // with an incomplete recipient set, so webhook status updates
          // couldn't find some rows and the aggregate counts drifted.
          // Flip the broadcast to failed so the user sees the problem
          // immediately, then throw to abort the send loop.
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: entries.length,
            })
            .eq('id', broadcast.id);
          throw new Error(
            `Failed to insert recipient batch ${i / INSERT_BATCH_SIZE + 1}: ${recipientError.message}`,
          );
        }
      }

      // ── Step 4: Hand delivery to the server ─────────────────
      // The fan-out no longer runs in this browser tab. Recipient rows are
      // already persisted as 'pending' with their frozen template params,
      // the broadcast row is 'sending', and the header URL is stored — so
      // the campaign is fully resumable server-side. The detail page we
      // navigate to auto-starts (and auto-continues) the server resume
      // chain via POST /api/whatsapp/broadcast/[id]/resume, delivering in
      // request-scoped server passes. Closing or backgrounding this tab no
      // longer strands the send. Return the id immediately so the wizard
      // can leave the page while delivery continues.
      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  /**
   * Build the SAME frozen recipient set the send-now path would, but hand
   * it to the schedule route instead of running the send loop. Reuses
   * resolveRecipients / fetchCustomValueIndex / resolveVariables — no
   * second copy of that logic — so a scheduled broadcast sends exactly
   * what clicking "Send Now" at that moment would have.
   */
  async function scheduleBroadcast(
    payload: BroadcastPayload,
    scheduledAt: string,
    timezone: string,
  ): Promise<string> {
    setIsProcessing(true);
    setProgress(0);
    const supabase = createClient();

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('You are not signed in.');
      if (!accountId) throw new Error('Your profile is not linked to an account.');
      if (!scheduledAt) throw new Error('Pick a date and time to schedule.');

      setProgress(20);
      const entries = await resolveRecipients(payload.audience);
      if (entries.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      setProgress(55);
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        [...new Set(entries.map((e) => e.contact.id))],
      );
      const recipients = entries.map((entry) => {
        const carouselParams = carouselForEntry(
          payload,
          entry,
          customValueIndex.get(entry.contact.id),
        );
        return {
          contact_id: entry.contact.id,
          template_params: paramsForEntry(
            payload,
            entry,
            customValueIndex.get(entry.contact.id),
          ),
          source: entry.source,
          ...(entry.sourceRow != null ? { source_row: entry.sourceRow } : {}),
          ...(carouselParams ? { carousel_params: carouselParams } : {}),
        };
      });

      setProgress(80);
      const groupSnapshot =
        payload.audience.type === 'groups' &&
        payload.audience.groupIds &&
        payload.audience.groupIds.length > 0
          ? await getGroupNamesByIds(supabase, payload.audience.groupIds)
          : null;
      const res = await fetch('/api/whatsapp/broadcast/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            // Same frozen groups snapshot as the send-now path.
            ...(payload.audience.type === 'groups' && payload.audience.groupIds
              ? { groupIds: payload.audience.groupIds, groupNames: groupSnapshot ?? [] }
              : {}),
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
            ...(payload.audience.type === 'csv' && payload.audience.csvFileName
              ? { csvFileName: payload.audience.csvFileName }
              : {}),
          },
          scheduled_at: scheduledAt,
          timezone,
          header_media_url: payload.headerMediaUrl?.trim() || null,
          send_delay_ms: Math.min(
            60_000,
            Math.max(0, Math.floor(payload.sendDelayMs ?? 0)),
          ),
          recipients,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Scheduling failed (HTTP ${res.status})`);
      }

      setProgress(100);
      return data.broadcast_id as string;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, scheduleBroadcast, isProcessing, progress };
}
