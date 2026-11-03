'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Users, FolderClosed } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Contacts | Groups tab switch. Groups lives at its own URL
 * (`/contacts/groups`) so it is linkable and refresh-safe; the tabs are
 * just navigation between the two pages, never in-page state.
 */
export function ContactsTabs() {
  const t = useTranslations('Contacts.tabs');
  const pathname = usePathname();
  const isGroups = pathname?.startsWith('/contacts/groups') ?? false;

  const tabClass = (active: boolean) =>
    cn(
      'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
      active
        ? 'bg-primary/10 text-primary'
        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
    );

  return (
    <div className="flex items-center gap-1 border-b border-border pb-0">
      <Link href="/contacts" className={cn(tabClass(!isGroups), 'mb-[-1px]')}>
        <Users className="size-4" />
        {t('contacts')}
      </Link>
      <Link href="/contacts/groups" className={cn(tabClass(isGroups), 'mb-[-1px]')}>
        <FolderClosed className="size-4" />
        {t('groups')}
      </Link>
    </div>
  );
}
