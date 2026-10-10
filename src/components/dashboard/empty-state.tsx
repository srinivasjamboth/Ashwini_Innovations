import { BarChart3 } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

import { useTranslations } from 'next-intl'

/**
 * Shared empty-state panel for views that can't render meaningfully
 * without a minimum amount of data. Kept minimal and uniform so the
 * three empty states on the dashboard don't each feel like a
 * different widget.
 *
 * `action` is optional and renders below the hint: list pages need a
 * way out of their own empty state (a "Create …" CTA), while chart
 * placeholders must stay where they are — the data arrives on its own.
 */
export function EmptyState({
  title,
  hint,
  icon: Icon = BarChart3,
  action,
  className,
}: {
  title?: string
  hint?: string
  icon?: ComponentType<{ className?: string }>
  action?: ReactNode
  className?: string
}) {
  const t = useTranslations('Dashboard.emptyState')
  const defaultTitle = t('title')
  
  return (
    <div
      className={cn(
        'flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/40 px-4 py-6 text-center',
        className,
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-muted-foreground">{title || defaultTitle}</p>
      {hint && <p className="max-w-xs text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
