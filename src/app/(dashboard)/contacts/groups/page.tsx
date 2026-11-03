'use client';

// ============================================================
// Groups tab — folder grid (design PART 1). One folder tile per
// group, a dashed "New group" tile first, debounced server-side
// search, the shared Pagination at GROUP_PAGE_SIZE folders per
// page, skeleton folders while loading, the existing empty state
// and an error state with Retry. Group data, membership and
// broadcasts are untouched — this is only the view over the same
// list_contact_groups RPC.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { ContactGroup } from '@/types';
import { listGroups, deleteGroup } from '@/lib/contacts/group-api';
import { GROUP_PAGE_SIZE } from '@/lib/contacts/group-colors';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { ContactsTabs } from '@/components/contacts/contacts-tabs';
import { GroupFormDialog } from '@/components/contacts/groups/group-form-dialog';
import {
  GroupFolderTile,
  type GroupFolderTileLabels,
} from '@/components/contacts/groups/group-folder-tile';
import { Pagination } from '@/components/admin/pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, Search, Loader2, FolderClosed, AlertCircle } from 'lucide-react';

/** Search keystrokes settle for this long before hitting the RPC. */
const SEARCH_DEBOUNCE_MS = 350;

export default function ContactGroupsPage() {
  const t = useTranslations('Contacts.groups.page');
  const supabase = createClient();
  const canEdit = useCan('send-messages');

  const [groups, setGroups] = useState<ContactGroup[]>([]);
  const [total, setTotal] = useState(0);
  // 1-based, matching the shared <Pagination> contract.
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<ContactGroup | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ContactGroup | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Debounced server-side search — typing never fires an RPC per key.
  useEffect(() => {
    const id = setTimeout(
      () => setSearch(searchInput.trim()),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(id);
  }, [searchInput]);

  // Same supersede guard as the contacts table: a slow earlier page
  // must never commit after a newer one.
  const fetchSeq = useRef(0);

  const fetchGroups = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    try {
      const { groups, total } = await listGroups(supabase, {
        search,
        limit: GROUP_PAGE_SIZE,
        offset: (page - 1) * GROUP_PAGE_SIZE,
      });
      if (seq !== fetchSeq.current) return;
      setGroups(groups);
      setTotal(total);
      setLoadError(false);
    } catch {
      if (seq !== fetchSeq.current) return;
      toast.error(t('toastLoadFailed'));
      setGroups([]);
      setTotal(0);
      setLoadError(true);
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [supabase, search, page, t]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  function openCreate() {
    setEditGroup(null);
    setFormOpen(true);
  }

  function openRename(group: ContactGroup) {
    setEditGroup(group);
    setFormOpen(true);
  }

  function confirmDelete(group: ContactGroup) {
    setDeleteTarget(group);
    setDeleteOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteGroup(supabase, deleteTarget.id);
      toast.success(t('toastDeleted', { name: deleteTarget.name }));
      // Deleting the last tile of a page — step back so the pager never
      // sits on an empty page.
      if (groups.length === 1 && page > 1) setPage((p) => p - 1);
      else fetchGroups();
    } catch {
      toast.error(t('toastDeleteFailed'));
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
      setDeleteTarget(null);
    }
  }

  const labels: GroupFolderTileLabels = {
    openAria: (name, count) => t('openAria', { name, count }),
    menuAria: '', // filled per tile below via interpolation
    edit: t('editAction'),
    delete: t('deleteAction'),
    broadcast: t('broadcastAction'),
    groupEyebrow: t('groupEyebrow'),
    contactsLabel: (count) =>
      count === 1 ? t('contactWord') : t('contactsWord'),
    unnamed: t('unnamed'),
  };

  return (
    <div className="space-y-6">
      <ContactsTabs />

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {total > 0 ? t('subtitle', { count: total }) : t('subtitleZero')}
          </p>
        </div>
        <GatedButton
          canAct={canEdit}
          gateReason="create groups"
          onClick={openCreate}
          className="bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <Plus className="size-4" />
          {t('createBtn')}
        </GatedButton>
      </div>

      {/* Search */}
      <div className="relative w-full max-w-sm">
        <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            setPage(1);
          }}
          placeholder={t('searchPlaceholder')}
          className="bg-card border-border text-foreground placeholder:text-muted-foreground pl-8"
        />
      </div>

      {/* Folder grid — top padding gives the hover cards room in the
          first row; overflow-visible keeps them from ever being
          clipped by this container. */}
      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-5 gap-y-8 overflow-visible pt-28">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-2">
              <div className="bg-muted aspect-[4/3] w-full max-w-[168px] animate-pulse rounded-xl" />
              <div className="bg-muted h-3 w-20 animate-pulse rounded" />
            </div>
          ))}
          <p className="text-muted-foreground col-span-full pt-2 text-center text-sm">
            {t('loading')}
          </p>
        </div>
      ) : loadError ? (
        <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 py-16">
          <AlertCircle className="text-muted-foreground size-8" />
          <p className="text-muted-foreground text-sm">{t('loadError')}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchGroups}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('retry')}
          </Button>
        </div>
      ) : groups.length === 0 ? (
        /* Empty state — centered create-group CTA with a sub text. */
        <div className="border-border bg-card/50 mx-auto flex min-h-[320px] max-w-lg flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center">
          <div className="bg-muted flex size-14 items-center justify-center rounded-full">
            <FolderClosed className="text-muted-foreground size-7" />
          </div>
          <h2 className="text-foreground mt-4 text-base font-semibold">
            {search.trim() ? t('emptyMatch') : t('emptyNone')}
          </h2>
          {!search.trim() && (
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              {t('emptySub')}
            </p>
          )}
          {!search.trim() && (
            <GatedButton
              canAct={canEdit}
              gateReason="create groups"
              onClick={openCreate}
              className="bg-primary hover:bg-primary/90 text-primary-foreground mt-5"
            >
              <Plus className="size-4" />
              {t('createFirst')}
            </GatedButton>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-5 gap-y-8 overflow-visible pt-28">
          {/* dashed "New group" folder — same create panel as the
              header button (which stays). */}
          {canEdit && (
            <div className="relative pt-2 text-center">
              <div className="relative mx-auto w-full max-w-[168px]">
                <button
                  type="button"
                  onClick={openCreate}
                  className="border-border text-muted-foreground hover:border-primary/60 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background flex aspect-[4/3] w-full items-center justify-center rounded-xl border-2 border-dashed transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                  aria-label={t('newGroupTileAria')}
                >
                  <Plus className="size-6" />
                </button>
                <p className="text-muted-foreground mt-2 block truncate px-1 text-sm">
                  {t('newGroupTile')}
                </p>
              </div>
            </div>
          )}

          {groups.map((group) => (
            <GroupFolderTile
              key={group.id}
              group={group}
              labels={{
                ...labels,
                menuAria: t('rowMenuAria', { name: group.name }),
              }}
              onEdit={openRename}
              onDelete={confirmDelete}
            />
          ))}
        </div>
      )}

      {/* Shared pagination (1-based) */}
      {total > GROUP_PAGE_SIZE && (
        <Pagination
          page={page}
          pageSize={GROUP_PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      )}

      <p className="text-muted-foreground text-xs">
        <Link href="/contacts" className="text-primary hover:underline">
          {t('backToContacts')}
        </Link>
      </p>

      {/* Create / edit dialog */}
      <GroupFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        group={editGroup}
        onSaved={() => fetchGroups()}
      />

      {/* Delete confirmation — members are never deleted, only the
          group and its membership rows. */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteDesc', {
                name: deleteTarget?.name ?? '',
                count: deleteTarget?.member_count ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
