'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { Contact } from '@/types';
import {
  addGroupMembersByIds,
  addGroupMembersByFilter,
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
import { Loader2, Search, CheckCircle2 } from 'lucide-react';

const PAGE_SIZE = 50;

interface AddMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string;
  groupName: string;
  onAdded?: () => void;
}

/**
 * Group-detail "Add members" picker. Contacts are searched and paged;
 * ticking "Select all N matching" switches to the server-side filter
 * path of `add_group_members`, so thousands of contacts across every
 * page are added in one statement instead of shipping ids around.
 */
export function AddMembersDialog({
  open,
  onOpenChange,
  groupId,
  groupName,
  onAdded,
}: AddMembersDialogProps) {
  const t = useTranslations('Contacts.groups.addMembers');
  const supabase = createClient();

  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Contact ids on the loaded pages that are already members — shown
  // checked-in with a badge; re-adding them is a no-op anyway.
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [adding, setAdding] = useState(false);

  const fetchPage = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        let query = supabase
          .from('contacts')
          .select('id, name, phone, email, created_at', { count: 'exact' })
          .order('created_at', { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);
        const term = search.trim();
        if (term) {
          const like = `%${term}%`;
          query = query.or(
            `name.ilike.${like},phone.ilike.${like},email.ilike.${like}`
          );
        }
        const { data, count, error } = await query;
        if (error) throw error;
        const rows = (data ?? []) as Contact[];
        setContacts(rows);
        setTotal(count ?? 0);

        // Mark the ones already inside this group (page-scoped ids only).
        if (rows.length > 0) {
          const { data: memberRows } = await supabase
            .from('contact_group_members')
            .select('contact_id')
            .eq('group_id', groupId)
            .in('contact_id', rows.map((r) => r.id));
          setMemberIds(new Set((memberRows ?? []).map((r) => r.contact_id)));
        } else {
          setMemberIds(new Set());
        }
      } catch {
        toast.error(t('toastLoadFailed'));
        setContacts([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [supabase, groupId, search, t]
  );

  useEffect(() => {
    if (open) {
      setPage(0);
      setSelectedIds(new Set());
      setAllMatching(false);
      fetchPage(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groupId]);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAllMatching(false);
  }

  async function handleAdd() {
    setAdding(true);
    try {
      const added = allMatching
        ? await addGroupMembersByFilter(supabase, groupId, { search })
        : await addGroupMembersByIds(supabase, groupId, [...selectedIds]);
      toast.success(
        allMatching
          ? t('toastAddedMatching', { count: added, group: groupName })
          : t('toastAdded', { count: added, group: groupName })
      );
      onOpenChange(false);
      onAdded?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastFailed'));
    } finally {
      setAdding(false);
    }
  }

  const canAdd = allMatching || selectedIds.size > 0;
  const hasNext = (page + 1) * PAGE_SIZE < total;
  const hasPrev = page > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,680px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-lg">
        <div className="shrink-0 space-y-3 border-b border-border/80 px-6 pt-6 pb-4">
          <DialogHeader className="gap-1">
            <DialogTitle className="text-lg text-popover-foreground">
              {t('title')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('desc', { group: groupName })}
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  fetchPage(0);
                }
              }}
              placeholder={t('searchPlaceholder')}
              className="bg-muted border-border text-foreground pl-8"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">{t('loading')}</span>
            </div>
          ) : contacts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('noContacts')}
            </p>
          ) : (
            <div className="space-y-0.5">
              {contacts.map((c) => {
                const isMember = memberIds.has(c.id);
                return (
                  <label
                    key={c.id}
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={isMember || selectedIds.has(c.id)}
                      disabled={isMember}
                      onCheckedChange={() => toggle(c.id)}
                      aria-label={c.name || c.phone}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-popover-foreground">
                        {c.name || t('unnamed')}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {c.phone}
                      </span>
                    </span>
                    {isMember && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        <CheckCircle2 className="size-3" />
                        {t('alreadyMember')}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between py-2 text-xs text-muted-foreground">
              <p>
                {t('showing', {
                  start: page * PAGE_SIZE + 1,
                  end: Math.min((page + 1) * PAGE_SIZE, total),
                  total,
                })}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!hasPrev || loading}
                  onClick={() => {
                    const next = page - 1;
                    setPage(next);
                    fetchPage(next * PAGE_SIZE);
                  }}
                >
                  {t('prev')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!hasNext || loading}
                  onClick={() => {
                    const next = page + 1;
                    setPage(next);
                    fetchPage(next * PAGE_SIZE);
                  }}
                >
                  {t('next')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 space-y-3 border-t border-border/80 px-6 py-4">
          <label className="flex items-center gap-2 text-xs text-popover-foreground cursor-pointer">
            <Checkbox
              checked={allMatching}
              onCheckedChange={(v) => {
                setAllMatching(v === true);
                if (v === true) setSelectedIds(new Set());
              }}
            />
            {t('selectAllMatching', { count: total })}
          </label>
          <DialogFooter className="bg-transparent border-0">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleAdd}
              disabled={!canAdd || adding}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {adding && <Loader2 className="size-4 animate-spin" />}
              {t('addBtn')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
