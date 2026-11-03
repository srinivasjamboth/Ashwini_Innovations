'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { ContactGroup } from '@/types';
import { listGroups, deleteGroup } from '@/lib/contacts/group-api';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { ContactsTabs } from '@/components/contacts/contacts-tabs';
import { GroupFormDialog } from '@/components/contacts/groups/group-form-dialog';
import { Pagination } from '@/components/admin/pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Search,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  FolderClosed,
} from 'lucide-react';

const PAGE_SIZE = 25;

export default function ContactGroupsPage() {
  const t = useTranslations('Contacts.groups.page');
  const router = useRouter();
  const supabase = createClient();
  const canEdit = useCan('send-messages');

  const [groups, setGroups] = useState<ContactGroup[]>([]);
  const [total, setTotal] = useState(0);
  // 1-based, matching the shared <Pagination> contract.
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<ContactGroup | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ContactGroup | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Same supersede guard as the contacts table: a slow earlier page
  // must never commit after a newer one.
  const fetchSeq = useRef(0);

  const fetchGroups = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    try {
      const { groups, total } = await listGroups(supabase, {
        search,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      if (seq !== fetchSeq.current) return;
      setGroups(groups);
      setTotal(total);
    } catch {
      if (seq !== fetchSeq.current) return;
      toast.error(t('toastLoadFailed'));
      setGroups([]);
      setTotal(0);
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
      // Deleting the last row of a page — step back so the pager never
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

  return (
    <div className="space-y-6">
      <ContactsTabs />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
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
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder={t('searchPlaceholder')}
          className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">{t('columns.name')}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">
                {t('columns.description')}
              </TableHead>
              <TableHead className="text-muted-foreground">{t('columns.members')}</TableHead>
              <TableHead className="text-muted-foreground hidden lg:table-cell">
                {t('columns.createdAt')}
              </TableHead>
              <TableHead className="text-muted-foreground w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={5} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : groups.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={5} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <FolderClosed className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {search.trim() ? t('emptyMatch') : t('emptyNone')}
                    </p>
                    {!search.trim() && (
                      <GatedButton
                        canAct={canEdit}
                        gateReason="create groups"
                        variant="outline"
                        size="sm"
                        onClick={openCreate}
                        className="mt-2 border-border text-muted-foreground hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t('createFirst')}
                      </GatedButton>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              groups.map((group) => (
                <TableRow
                  key={group.id}
                  className="border-border hover:bg-muted/50 cursor-pointer"
                  onClick={() => router.push(`/contacts/groups/${group.id}`)}
                >
                  <TableCell className="text-foreground font-medium">
                    {group.name}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground max-w-[16rem]">
                    <span className="block truncate" title={group.description ?? ''}>
                      {group.description || '-'}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {group.member_count?.toLocaleString() ?? 0}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-muted-foreground text-xs">
                    {new Date(group.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={(e) => e.stopPropagation()}
                            aria-label={t('rowMenuAria', { name: group.name })}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-popover border-border">
                        <DropdownMenuItem
                          onClick={() =>
                            router.push(`/contacts/groups/${group.id}`)
                          }
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <FolderClosed className="size-4" />
                          {t('openAction')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => openRename(group)}
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <Pencil className="size-4" />
                          {t('renameAction')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => confirmDelete(group)}
                        >
                          <Trash2 className="size-4" />
                          {t('deleteAction')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Shared pagination (1-based) */}
      {total > PAGE_SIZE && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      )}

      <p className="text-xs text-muted-foreground">
        <Link href="/contacts" className="text-primary hover:underline">
          {t('backToContacts')}
        </Link>
      </p>

      {/* Create / rename dialog */}
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
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
