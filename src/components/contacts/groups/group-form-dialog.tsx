'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { ContactGroup } from '@/types';
import {
  GroupNameConflictError,
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
  createGroup,
  updateGroup,
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
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

interface GroupFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present = rename/edit; null = create. */
  group?: ContactGroup | null;
  onSaved?: (group: ContactGroup) => void;
}

/** Create / rename dialog (the "SidePanel" of the groups spec, rendered
 *  with the shared Dialog — the tremor library has no side panel). */
export function GroupFormDialog({
  open,
  onOpenChange,
  group,
  onSaved,
}: GroupFormDialogProps) {
  const t = useTranslations('Contacts.groups.form');
  const supabase = createClient();
  const { accountId } = useAuth();
  const isEdit = !!group;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(group?.name ?? '');
      setDescription(group?.description ?? '');
    }
  }, [open, group]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t('nameRequired'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNoAccount'));
      return;
    }

    setSaving(true);
    try {
      const saved = isEdit
        ? await updateGroup(supabase, group.id, {
            name: trimmed,
            description,
          })
        : await createGroup(supabase, {
            accountId,
            name: trimmed,
            description,
          });
      toast.success(isEdit ? t('toastUpdated') : t('toastCreated'));
      onOpenChange(false);
      onSaved?.(saved);
    } catch (err) {
      if (err instanceof GroupNameConflictError) {
        toast.error(t('toastDuplicate', { name: trimmed }));
      } else {
        toast.error(
          err instanceof Error ? err.message : t('toastFailed')
        );
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? t('editTitle') : t('createTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEdit ? t('editDesc') : t('createDesc')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="group-name" className="text-muted-foreground">
              {t('nameLabel')} <span className="text-red-400">*</span>
            </Label>
            <Input
              id="group-name"
              value={name}
              maxLength={GROUP_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
            <p className="text-xs text-muted-foreground">
              {t('nameHint', { max: GROUP_NAME_MAX })}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="group-description" className="text-muted-foreground">
              {t('descLabel')}
            </Label>
            <Input
              id="group-description"
              value={description}
              maxLength={GROUP_DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('descPlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? t('save') : t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
