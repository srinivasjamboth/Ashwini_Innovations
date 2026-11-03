'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { ContactGroup } from '@/types';
import {
  GroupNameConflictError,
  addGroupMembersByIds,
  addGroupMembersByFilter,
  createGroup,
  listAllGroups,
  normalizeGroupName,
} from '@/lib/contacts/group-api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Plus } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';

interface AddToGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Contacts visibly selected (page-scoped). */
  contactIds: string[];
  /** When set, the dialog also offers "all contacts matching the
   *  current filters" — resolved server-side so it spans pages. */
  allMatching?: {
    total: number;
    tagIds?: string[];
    groupIds?: string[];
    search?: string;
  };
  onDone?: () => void;
}

/** Bulk "Add to group" from the Contacts page. Re-adding a contact that
 *  is already a member is a harmless no-op (ON CONFLICT DO NOTHING). */
export function AddToGroupDialog({
  open,
  onOpenChange,
  contactIds,
  allMatching,
  onDone,
}: AddToGroupDialogProps) {
  const t = useTranslations('Contacts.groups.addToGroup');
  const supabase = createClient();
  const { accountId } = useAuth();

  const [groups, setGroups] = useState<ContactGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [addAllMatching, setAddAllMatching] = useState(false);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      setGroups(await listAllGroups(supabase));
    } catch {
      toast.error(t('toastLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [supabase, t]);

  useEffect(() => {
    if (open) {
      setSelectedIds([]);
      setNewName('');
      setAddAllMatching(false);
      fetchGroups();
    }
  }, [open, fetchGroups]);

  function toggle(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]
    );
  }

  async function handleCreateInline() {
    const name = normalizeGroupName(newName);
    if (!name || !accountId) return;
    setCreating(true);
    try {
      const created = await createGroup(supabase, { accountId, name });
      setGroups((prev) =>
        [...prev, created].sort((a, b) => a.name.localeCompare(b.name))
      );
      setSelectedIds((prev) =>
        prev.includes(created.id) ? prev : [...prev, created.id]
      );
      setNewName('');
    } catch (err) {
      toast.error(
        err instanceof GroupNameConflictError
          ? t('toastDuplicate', { name })
          : t('toastCreateFailed')
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleApply() {
    if (selectedIds.length === 0 || applying) return;
    setApplying(true);
    let failed = 0;
    for (const groupId of selectedIds) {
      try {
        if (addAllMatching && allMatching) {
          await addGroupMembersByFilter(supabase, groupId, {
            groupIds: allMatching.groupIds,
            tagIds: allMatching.tagIds,
            search: allMatching.search,
          });
        } else {
          await addGroupMembersByIds(supabase, groupId, contactIds);
        }
      } catch {
        failed++;
      }
    }
    setApplying(false);
    if (failed === 0) {
      toast.success(
        addAllMatching && allMatching
          ? t('toastAddedAllMatching', {
              groups: selectedIds.length,
              count: allMatching.total,
            })
          : t('toastAdded', { groups: selectedIds.length, count: contactIds.length })
      );
    } else {
      toast.error(t('toastPartial', { failed, total: selectedIds.length }));
    }
    onOpenChange(false);
    onDone?.();
  }

  const countLabel =
    addAllMatching && allMatching
      ? t('targetAllMatching', { count: allMatching.total })
      : t('targetSelected', { count: contactIds.length });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,640px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-md">
        <div className="shrink-0 space-y-1.5 border-b border-border/80 px-6 pt-6 pb-4">
          <DialogHeader className="gap-1">
            <DialogTitle className="text-lg text-popover-foreground">
              {t('title')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('desc', { count: contactIds.length })}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {allMatching && (
            <label className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3 cursor-pointer">
              <Checkbox
                checked={addAllMatching}
                onCheckedChange={(v) => setAddAllMatching(v === true)}
                className="mt-0.5"
              />
              <span className="text-xs text-popover-foreground">
                {t('allMatchingOption', { count: allMatching.total })}
                <span className="mt-0.5 block text-muted-foreground">
                  {t('allMatchingHint')}
                </span>
              </span>
            </label>
          )}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">{t('loading')}</span>
            </div>
          ) : groups.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t('noGroups')}
            </p>
          ) : (
            <div className="space-y-1">
              {groups.map((group) => (
                <label
                  key={group.id}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50"
                >
                  <Checkbox
                    checked={selectedIds.includes(group.id)}
                    onCheckedChange={() => toggle(group.id)}
                    aria-label={group.name}
                  />
                  <span className="text-sm text-popover-foreground truncate">
                    {group.name}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {group.member_count ?? 0}
                  </span>
                </label>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2 border-t border-border pt-4">
            <div className="flex-1 space-y-1">
              <label htmlFor="atg-new-group" className="text-xs text-muted-foreground">
                {t('createInlineLabel')}
              </label>
              <Input
                id="atg-new-group"
                value={newName}
                maxLength={50}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('createInlinePlaceholder')}
                className="bg-muted border-border text-foreground"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleCreateInline}
              disabled={!newName.trim() || creating || !accountId}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {creating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              {t('createInlineBtn')}
            </Button>
          </div>
        </div>

        <div className="shrink-0 border-t border-border/80 px-6 py-4">
          <DialogFooter className="bg-transparent border-0">
            <p className="mr-auto text-xs text-muted-foreground">{countLabel}</p>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleApply}
              disabled={selectedIds.length === 0 || applying}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {applying && <Loader2 className="size-4 animate-spin" />}
              {t('addBtn')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
