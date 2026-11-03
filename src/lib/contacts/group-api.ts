import { createClient } from '@/lib/supabase/client';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import type { Contact, ContactGroup } from '@/types';

type SupabaseClient = ReturnType<typeof createClient>;

/** PostgREST caps `.in(...)` lists around 1000 values — chunk below it. */
const IN_CHUNK = 500;
/** `resolve_group_contact_ids` page size (its server-side default). */
const RESOLVE_PAGE = 1000;

export const GROUP_NAME_MAX = 50;
export const GROUP_DESCRIPTION_MAX = 200;

/** Groups are a light-weight organizing tool — trim + collapse runs of
 *  whitespace so "VIP " and "VIP" aren't two rows the DB can't tell
 *  apart anyway (its unique index is on the lowercased name). */
export function normalizeGroupName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, GROUP_NAME_MAX);
}

export class GroupNameConflictError extends Error {
  constructor(name: string) {
    super(`A group named "${name}" already exists.`);
    this.name = 'GroupNameConflictError';
  }
}

/** A name rejected by the DB CHECK (empty or > 50 chars). */
export function isGroupNameViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  return code === '23514' || code === '22023';
}

interface GroupListRow extends ContactGroup {
  member_count: number;
  total_count: number;
}

/** One page of the groups table: live member counts + windowed total,
 *  all resolved server-side by `list_contact_groups` (migration 056). */
export async function listGroups(
  supabase: SupabaseClient,
  opts: { search?: string; limit?: number; offset?: number } = {}
): Promise<{ groups: ContactGroup[]; total: number }> {
  const { data, error } = await supabase.rpc('list_contact_groups', {
    p_search: opts.search?.trim() || null,
    p_limit: opts.limit ?? 25,
    p_offset: opts.offset ?? 0,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as GroupListRow[];
  return {
    groups: rows.map((row) => ({
      id: row.id,
      account_id: row.account_id,
      name: row.name,
      description: row.description,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      member_count: row.member_count,
    })),
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
  };
}

/** Every group (search optional) for pickers — pages through the same
 *  RPC so a huge account can never silently truncate the list the way
 *  a plain capped select would. */
export async function listAllGroups(
  supabase: SupabaseClient,
  search?: string
): Promise<ContactGroup[]> {
  const all: ContactGroup[] = [];
  const PAGE = 200;
  for (let offset = 0; ; offset += PAGE) {
    const { groups, total } = await listGroups(supabase, {
      search,
      limit: PAGE,
      offset,
    });
    all.push(...groups);
    if (groups.length === 0 || all.length >= total) return all;
  }
}

/** Single group by id (RLS-scoped — foreign ids read as null), with the
 *  live member count. */
export async function getGroup(
  supabase: SupabaseClient,
  groupId: string
): Promise<ContactGroup | null> {
  const { data, error } = await supabase
    .from('contact_groups')
    .select('*')
    .eq('id', groupId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const { count } = await supabase
    .from('contact_group_members')
    .select('contact_id', { count: 'exact', head: true })
    .eq('group_id', groupId);
  return { ...(data as ContactGroup), member_count: count ?? 0 };
}

export async function createGroup(
  supabase: SupabaseClient,
  input: { accountId: string; name: string; description?: string }
): Promise<ContactGroup> {
  const name = normalizeGroupName(input.name);
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const { data, error } = await supabase
    .from('contact_groups')
    .insert({
      account_id: input.accountId,
      name,
      description: input.description?.trim().slice(0, GROUP_DESCRIPTION_MAX) || null,
      created_by: session?.user.id ?? null,
    })
    .select()
    .single();
  if (error) {
    if (isUniqueViolation(error)) throw new GroupNameConflictError(name);
    if (isGroupNameViolation(error)) throw new Error('Group name is required (1–50 characters).');
    throw new Error(error.message);
  }
  return data as ContactGroup;
}

export async function updateGroup(
  supabase: SupabaseClient,
  groupId: string,
  input: { name: string; description?: string }
): Promise<ContactGroup> {
  const name = normalizeGroupName(input.name);
  const { data, error } = await supabase
    .from('contact_groups')
    .update({
      name,
      description: input.description?.trim().slice(0, GROUP_DESCRIPTION_MAX) || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', groupId)
    .select()
    .single();
  if (error) {
    if (isUniqueViolation(error)) throw new GroupNameConflictError(name);
    if (isGroupNameViolation(error)) throw new Error('Group name is required (1–50 characters).');
    throw new Error(error.message);
  }
  return data as ContactGroup;
}

/** Deleting a group only removes membership rows (CASCADE) — the
 *  contacts themselves are never touched. */
export async function deleteGroup(
  supabase: SupabaseClient,
  groupId: string
): Promise<void> {
  const { error } = await supabase.from('contact_groups').delete().eq('id', groupId);
  if (error) throw new Error(error.message);
}

/** Members page of a group: search + windowed total in one round-trip. */
export async function listGroupMembers(
  supabase: SupabaseClient,
  groupId: string,
  opts: { search?: string; limit?: number; offset?: number } = {}
): Promise<{ contacts: Contact[]; total: number }> {
  const { data, error } = await supabase.rpc('list_group_members', {
    p_group_id: groupId,
    p_search: opts.search?.trim() || null,
    p_limit: opts.limit ?? 25,
    p_offset: opts.offset ?? 0,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { contact: Contact; total_count: number }[];
  return {
    contacts: rows.map((r) => r.contact),
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
  };
}

/** Add by explicit ids via `add_group_members` — re-adding an existing
 *  member is a harmless no-op (ON CONFLICT DO NOTHING). Returns the
 *  number of NEW memberships actually created. */
export async function addGroupMembersByIds(
  supabase: SupabaseClient,
  groupId: string,
  contactIds: string[]
): Promise<number> {
  let added = 0;
  for (let i = 0; i < contactIds.length; i += IN_CHUNK) {
    const { data, error } = await supabase.rpc('add_group_members', {
      p_group_id: groupId,
      p_contact_ids: contactIds.slice(i, i + IN_CHUNK),
    });
    if (error) throw new Error(error.message);
    added += Number(data ?? 0);
  }
  return added;
}

/** "All contacts matching the current filters", resolved server-side in
 *  one statement so it works across pages and thousands of rows. */
export async function addGroupMembersByFilter(
  supabase: SupabaseClient,
  groupId: string,
  filter: { groupIds?: string[]; tagIds?: string[]; search?: string }
): Promise<number> {
  const { data, error } = await supabase.rpc('add_group_members', {
    p_group_id: groupId,
    p_filter_group_ids:
      filter.groupIds && filter.groupIds.length > 0 ? filter.groupIds : null,
    p_filter_tag_ids:
      filter.tagIds && filter.tagIds.length > 0 ? filter.tagIds : null,
    p_search: filter.search?.trim() || null,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

export async function removeGroupMembers(
  supabase: SupabaseClient,
  groupId: string,
  contactIds: string[]
): Promise<void> {
  for (let i = 0; i < contactIds.length; i += IN_CHUNK) {
    const { error } = await supabase
      .from('contact_group_members')
      .delete()
      .eq('group_id', groupId)
      .in('contact_id', contactIds.slice(i, i + IN_CHUNK));
    if (error) throw new Error(error.message);
  }
}

/** EVERY member id across the selected groups, de-duplicated
 *  server-side (one message per contact even across overlaps) and
 *  paged past the 1000-row cap. */
export async function resolveGroupContactIds(
  supabase: SupabaseClient,
  groupIds: string[]
): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const ids: string[] = [];
  for (let offset = 0; ; offset += RESOLVE_PAGE) {
    const { data, error } = await supabase.rpc('resolve_group_contact_ids', {
      p_group_ids: groupIds,
      p_limit: RESOLVE_PAGE,
      p_offset: offset,
    });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { contact_id: string; total_count: number }[];
    ids.push(...rows.map((r) => r.contact_id));
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    if (rows.length === 0 || ids.length >= total) return ids;
  }
}

/** Names behind the given ids, frozen onto the campaign audience
 *  snapshot at create/schedule time. A group deleted after a campaign
 *  was sent simply drops out — the ids stay the source of truth. */
export async function getGroupNamesByIds(
  supabase: SupabaseClient,
  groupIds: string[]
): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const names: string[] = [];
  for (let i = 0; i < groupIds.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('contact_groups')
      .select('name')
      .in('id', groupIds.slice(i, i + IN_CHUNK));
    if (error) throw new Error(error.message);
    names.push(...(data ?? []).map((r) => r.name as string));
  }
  return names;
}

/** Contacts-page "Groups" filter (ANY group, AND with the tag
 *  dimension) — search + windowed total in one round-trip. */
export async function filterContactsByGroups(
  supabase: SupabaseClient,
  opts: {
    groupIds: string[];
    tagIds?: string[];
    search?: string;
    limit?: number;
    offset?: number;
  }
): Promise<{ contacts: Contact[]; total: number }> {
  const { data, error } = await supabase.rpc('filter_contacts_by_groups', {
    p_group_ids: opts.groupIds,
    p_tag_ids: opts.tagIds && opts.tagIds.length > 0 ? opts.tagIds : null,
    p_search: opts.search?.trim() || null,
    p_limit: opts.limit ?? 25,
    p_offset: opts.offset ?? 0,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { contact: Contact; total_count: number }[];
  return {
    contacts: rows.map((r) => r.contact),
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
  };
}

export async function getGroupIdsForContact(
  supabase: SupabaseClient,
  contactId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from('contact_group_members')
    .select('group_id')
    .eq('contact_id', contactId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.group_id);
}

/** Diff desired vs current memberships for one contact. Adding an
 *  existing member is a no-op (PK conflict ignored), so a lost race
 *  can't fail the save. */
export async function syncContactGroups(
  supabase: SupabaseClient,
  contactId: string,
  desiredGroupIds: string[]
): Promise<void> {
  const current = await getGroupIdsForContact(supabase, contactId);
  const currentSet = new Set(current);
  const desiredSet = new Set(desiredGroupIds);

  const toRemove = current.filter((id) => !desiredSet.has(id));
  const toAdd = desiredGroupIds.filter((id) => !currentSet.has(id));

  if (toRemove.length > 0) {
    const { error } = await supabase
      .from('contact_group_members')
      .delete()
      .eq('contact_id', contactId)
      .in('group_id', toRemove);
    if (error) throw new Error(error.message);
  }
  if (toAdd.length > 0) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const { error } = await supabase
      .from('contact_group_members')
      .upsert(
        toAdd.map((group_id) => ({
          group_id,
          contact_id: contactId,
          added_by: session?.user.id ?? null,
        })),
        { onConflict: 'group_id,contact_id', ignoreDuplicates: true }
      );
    if (error) throw new Error(error.message);
  }
}
