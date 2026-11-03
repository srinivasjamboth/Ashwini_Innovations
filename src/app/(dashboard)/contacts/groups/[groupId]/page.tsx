'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { Contact, ContactGroup } from '@/types';
import {
  deleteGroup,
  getActiveGroupAddJob,
  getGroup,
  listGroupMembers,
  removeGroupMembers,
  runGroupAddJobChunk,
} from '@/lib/contacts/group-api';
import { resolveGroupColor } from '@/lib/contacts/group-colors';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { GroupFormDialog } from '@/components/contacts/groups/group-form-dialog';
import { AddMembersDialog } from '@/components/contacts/groups/add-members-dialog';
import {
  AddByFilterPanel,
} from '@/components/contacts/groups/add-by-filter-panel';
import { FolderPreview } from '@/components/contacts/groups/group-folder-tile';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { Pagination } from '@/components/admin/pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
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
  ArrowLeft,
  Loader2,
  Megaphone,
  Pencil,
  Search,
  SlidersHorizontal,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';

const PAGE_SIZE = 25;

export default function GroupDetailPage() {
  const t = useTranslations('Contacts.groups.detail');
  const params = useParams<{ groupId: string }>();
  const groupId = params?.groupId ?? '';
  const router = useRouter();
  const supabase = createClient();
  const canEdit = useCan('send-messages');

  const [group, setGroup] = useState<ContactGroup | null>(null);
  const [groupLoading, setGroupLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [members, setMembers] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loadingMembers, setLoadingMembers] = useState(true);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [addFilterOpen, setAddFilterOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteGroupOpen, setDeleteGroupOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Resumable background add (spec PART 4): a >5,000 run started from
  // the panel survives a refresh — the live job row is picked up here
  // and chunked onward.
  const [activeJob, setActiveJob] = useState<{
    jobId: string;
    added: number;
    target: number;
  } | null>(null);
  const [jobRunning, setJobRunning] = useState(false);

  const fetchSeq = useRef(0);

  const fetchGroup = useCallback(async () => {
    if (!groupId) return;
    setGroupLoading(true);
    try {
      const g = await getGroup(supabase, groupId);
      if (!g) {
        setNotFound(true);
      } else {
        setGroup(g);
        setNotFound(false);
      }
    } catch {
      setNotFound(true);
    } finally {
      setGroupLoading(false);
    }
  }, [supabase, groupId]);

  const fetchMembers = useCallback(async () => {
    if (!groupId) return;
    const seq = ++fetchSeq.current;
    setLoadingMembers(true);
    // The visible rows are about to change — drop page-scoped selections.
    setSelected(new Set());
    try {
      const { contacts, total } = await listGroupMembers(supabase, groupId, {
        search,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      if (seq !== fetchSeq.current) return;
      setMembers(contacts);
      setTotal(total);
    } catch {
      if (seq !== fetchSeq.current) return;
      toast.error(t('toastLoadFailed'));
      setMembers([]);
      setTotal(0);
    } finally {
      if (seq === fetchSeq.current) setLoadingMembers(false);
    }
  }, [supabase, groupId, search, page, t]);

  useEffect(() => {
    fetchGroup();
  }, [fetchGroup]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  // A removal (or search narrowing) can leave the current page past the
  // last one — clamp back instead of sitting on an empty table.
  useEffect(() => {
    if (loadingMembers || members.length > 0 || page <= 1) return;
    const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > maxPage) setPage(maxPage);
  }, [loadingMembers, members.length, page, total]);

  function refreshAll() {
    fetchGroup();
    fetchMembers();
  }

  const allOnPageSelected =
    members.length > 0 && members.every((c) => selected.has(c.id));
  const someOnPageSelected = members.some((c) => selected.has(c.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) members.forEach((c) => next.delete(c.id));
      else members.forEach((c) => next.add(c.id));
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleRemove(ids: string[]) {
    if (ids.length === 0 || removing || !group) return;
    setRemoving(true);
    try {
      await removeGroupMembers(supabase, group.id, ids);
      toast.success(t('toastRemoved', { count: ids.length }));
      setSelected(new Set());
      refreshAll();
    } catch {
      toast.error(t('toastRemoveFailed'));
    } finally {
      setRemoving(false);
    }
  }

  async function handleDeleteGroup() {
    if (!group) return;
    setDeletingGroup(true);
    try {
      await deleteGroup(supabase, group.id);
      toast.success(t('toastGroupDeleted'));
      router.push('/contacts/groups');
    } catch {
      toast.error(t('toastGroupDeleteFailed'));
    } finally {
      setDeletingGroup(false);
      setDeleteGroupOpen(false);
    }
  }

  const checkActiveJob = useCallback(async () => {
    if (!groupId) return;
    try {
      const job = await getActiveGroupAddJob(supabase, groupId);
      setActiveJob(job && job.target > 0 && job.added < job.target ? job : null);
    } catch {
      /* banner is best-effort */
    }
  }, [supabase, groupId]);

  useEffect(() => {
    checkActiveJob();
  }, [checkActiveJob]);

  async function continueActiveJob() {
    if (!activeJob || jobRunning) return;
    setJobRunning(true);
    try {
      let acc = activeJob.added;
      for (;;) {
        const res = await runGroupAddJobChunk(supabase, activeJob.jobId);
        acc += res.added;
        setActiveJob((j) =>
          j ? { ...j, added: acc, target: acc + res.remaining } : j
        );
        if (res.status === 'done') break;
      }
      toast.success(t('toastJobDone', { count: acc }));
      setActiveJob(null);
      refreshAll();
    } catch {
      toast.error(t('toastJobFailed'));
    } finally {
      setJobRunning(false);
    }
  }

  if (groupLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  if (notFound || !group) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
        <Link
          href="/contacts/groups"
          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="size-4" />
          {t('backToGroups')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <Link
            href="/contacts/groups"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {t('backToGroups')}
          </Link>
          <div className="flex items-center gap-2.5">
            {/* the group's folder, in its chosen shade (spec PART 3) */}
            <FolderPreview
              colorKey={resolveGroupColor(group.color, group.id)}
              className="h-8 w-10 shrink-0"
            />
            <div>
              <h1 className="text-2xl font-bold text-foreground">{group.name}</h1>
              <p className="text-sm text-muted-foreground">
                {t('membersCount', { count: group.member_count ?? 0 })}
              </p>
            </div>
          </div>
          {group.description && (
            <p className="max-w-xl text-sm text-muted-foreground">{group.description}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <GatedButton
            canAct={canEdit}
            gateReason="rename group"
            variant="outline"
            onClick={() => setRenameOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <Pencil className="size-4" />
            {t('renameBtn')}
          </GatedButton>
          <GatedButton
            canAct={canEdit}
            gateReason="delete group"
            variant="outline"
            onClick={() => setDeleteGroupOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <Trash2 className="size-4" />
            {t('deleteBtn')}
          </GatedButton>
          <Button
            variant="outline"
            onClick={() => setAddOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
            disabled={!canEdit}
          >
            <UserPlus className="size-4" />
            {t('addMembersBtn')}
          </Button>
          <Button
            variant="outline"
            onClick={() => setAddFilterOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
            disabled={!canEdit}
          >
            <SlidersHorizontal className="size-4" />
            {t('addByFilterBtn')}
          </Button>
          <Link href={`/broadcasts/new?groupIds=${group.id}`}>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Megaphone className="size-4" />
              {t('broadcastBtn')}
            </Button>
          </Link>
        </div>
      </div>

      {/* Background add-by-filter job left over from a refresh — shows
          progress and can carry the chunked run to the end. */}
      {activeJob && !addFilterOpen && (
        <div
          role="status"
          className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-4 py-2"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm text-foreground">
              {t('jobBanner', {
                added: activeJob.added.toLocaleString(),
                target: activeJob.target.toLocaleString(),
              })}
            </p>
            <div
              className="h-1.5 w-full overflow-hidden rounded bg-border"
              aria-hidden
            >
              <div
                className="h-full rounded bg-primary transition-[width] duration-200"
                style={{
                  width: `${activeJob.target > 0 ? Math.min(100, (activeJob.added / activeJob.target) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={continueActiveJob}
            disabled={jobRunning}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {jobRunning && <Loader2 className="size-3.5 animate-spin" />}
            {jobRunning ? t('jobRunning') : t('jobContinue')}
          </Button>
        </div>
      )}

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

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-4 py-2">
          <p className="text-sm text-foreground">{t('selectedCount', { count: selected.size })}</p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('clearSelection')}
            </Button>
            <GatedButton
              variant="destructive"
              size="sm"
              canAct={canEdit}
              gateReason="remove members"
              onClick={() => handleRemove([...selected])}
              disabled={removing}
            >
              {removing && <Loader2 className="size-4 animate-spin" />}
              {t('removeSelected')}
            </GatedButton>
          </div>
        </div>
      )}

      {/* Members table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={members.length === 0}
                  aria-label={t('selectAllOnPage')}
                />
              </TableHead>
              <TableHead className="text-muted-foreground">{t('columns.name')}</TableHead>
              <TableHead className="text-muted-foreground">{t('columns.phone')}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">
                {t('columns.email')}
              </TableHead>
              <TableHead className="text-muted-foreground hidden lg:table-cell">
                {t('columns.company')}
              </TableHead>
              <TableHead className="text-muted-foreground w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadingMembers ? (
              <TableRow className="border-border">
                <TableCell colSpan={6} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : members.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={6} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {search.trim() ? t('emptyMatch') : t('emptyNone')}
                    </p>
                    {!search.trim() && canEdit && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setAddOpen(true)}
                        className="mt-2 border-border text-muted-foreground hover:bg-muted"
                      >
                        <UserPlus className="size-3.5" />
                        {t('addMembersBtn')}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              members.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="border-border hover:bg-muted/50 cursor-pointer"
                  onClick={() => {
                    setDetailContactId(contact.id);
                    setDetailOpen(true);
                  }}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(contact.id)}
                      onCheckedChange={() => toggleSelect(contact.id)}
                      aria-label={contact.name || contact.phone}
                    />
                  </TableCell>
                  <TableCell className="text-foreground font-medium">
                    {contact.name || (
                      <span className="italic text-muted-foreground">{t('unnamed')}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {contact.phone}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    {contact.email || <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                    {contact.company || <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <GatedButton
                      variant="ghost"
                      size="sm"
                      canAct={canEdit}
                      gateReason="remove member"
                      onClick={() => handleRemove([contact.id])}
                      disabled={removing}
                      className="text-muted-foreground hover:text-red-400"
                    >
                      <Trash2 className="size-4" />
                      {t('removeAction')}
                    </GatedButton>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {total > PAGE_SIZE && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      )}

      {/* Add members picker */}
      <AddMembersDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        groupId={group.id}
        groupName={group.name}
        onAdded={refreshAll}
      />

      {/* Add members by filter (spec PART 4) */}
      <AddByFilterPanel
        open={addFilterOpen}
        onOpenChange={(next) => {
          setAddFilterOpen(next);
          if (!next) checkActiveJob();
        }}
        groupId={group.id}
        groupName={group.name}
        onAdded={refreshAll}
      />

      {/* Rename dialog */}
      <GroupFormDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        group={group}
        onSaved={() => refreshAll()}
      />

      {/* Contact detail sheet (shared with the Contacts page) */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchMembers}
      />

      {/* Delete group confirmation */}
      <Dialog open={deleteGroupOpen} onOpenChange={setDeleteGroupOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteGroupTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteGroupDesc', {
                name: group.name,
                count: group.member_count ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteGroupOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDeleteGroup} disabled={deletingGroup}>
              {deletingGroup && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
