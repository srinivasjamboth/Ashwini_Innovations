'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Search,
  X,
  Eye,
  Pencil,
  RotateCcw,
  Trash2,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Image as ImageIcon,
  Video,
  FileText,
  Type as TypeIcon,
  Minus,
} from 'lucide-react';
import type { MessageTemplate, MessageTemplateStatus } from '@/types';
import { templateStatusConfig } from '@/lib/template-status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Table view for the Templates page list.
 *
 * Replaces the old two-column card grid with the same table pattern the
 * Contacts page uses (ui/table inside a rounded border container, sticky
 * header, hover rows) and adds full pagination.
 *
 * Pagination is CLIENT-SIDE on purpose: the parent (TemplateManager)
 * already loads every row of `message_templates` (select '*') in one
 * query, body text included, so the complete, RLS-scoped set is in memory
 * — search, tab counts and page slices all run against it with no extra
 * request and no endpoint change. Every behaviour the spec asks for is
 * reproduced here: URL-driven state (?page &pageSize &tab &q), clamping,
 * deterministic newest-first ordering with an id tie-breaker, a page-size
 * selector remembered in localStorage, an ellipsis pager with a compact
 * mobile variant, and a page-change effect (fade + scroll + focus +
 * aria-live). Because the data is local and page changes are synchronous,
 * there is no per-page request to race — the "ignore out-of-order
 * responses" rule is satisfied by construction.
 *
 * Everything is display-only: edits, deletes and the builder stay owned
 * by TemplateManager — this component just reports intent through
 * onEdit / onDelete / onView.
 *
 * The component must be rendered inside a <Suspense> boundary — it reads
 * useSearchParams.
 */

const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_STORAGE_KEY = 'ashwini.templates.pageSize';
type PageSize = (typeof PAGE_SIZES)[number];

/** Tab id → the raw DB statuses it contains. Other statuses (DRAFT,
 *  PAUSED, …) are only visible under "All", mirroring the old card list
 *  which showed every row unconditionally. */
const TAB_STATUSES: Record<string, MessageTemplateStatus[] | null> = {
  all: null,
  approved: ['APPROVED'],
  pending: ['PENDING'],
  rejected: ['REJECTED'],
};

type TabId = keyof typeof TAB_STATUSES;

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-600/20 text-purple-400 border-purple-600/30',
  Utility: 'bg-blue-600/20 text-blue-400 border-blue-600/30',
  Authentication: 'bg-amber-600/20 text-amber-400 border-amber-600/30',
};

/** localStorage is a per-browser UI preference; read it defensively so a
 *  blocked/absent store (SSR, private mode) just falls back to default. */
function readStoredPageSize(): PageSize {
  if (typeof window === 'undefined') return DEFAULT_PAGE_SIZE;
  try {
    const raw = Number(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    return (PAGE_SIZES as readonly number[]).includes(raw)
      ? (raw as PageSize)
      : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

/** Page numbers with ellipses, e.g. 1 … 4 5 6 … 20. */
function pageItems(current: number, total: number): (number | 'gap')[] {
  if (total <= 1) return [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);
  const out: (number | 'gap')[] = [1];
  if (left > 2) out.push('gap');
  for (let i = left; i <= right; i++) out.push(i);
  if (right < total - 1) out.push('gap');
  out.push(total);
  return out;
}

interface TemplateTableViewProps {
  templates: MessageTemplate[];
  /** Id of the row whose delete is in flight — its trash icon spins. */
  deletingId: string | null;
  onEdit: (template: MessageTemplate) => void;
  onDelete: (template: MessageTemplate) => void;
  onView: (template: MessageTemplate) => void;
}

export function TemplateTableView({
  templates,
  deletingId,
  onEdit,
  onDelete,
  onView,
}: TemplateTableViewProps) {
  const t = useTranslations('Settings.templates');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  // Search text and status tab are local UI state (the input needs to feel
  // instant); page & page-size are read straight from the URL so refresh,
  // shared links and back/forward restore the exact view.
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const [tab, setTab] = useState<TabId>(() => {
    const raw = searchParams.get('tab') ?? 'all';
    return raw in TAB_STATUSES ? (raw as TabId) : 'all';
  });
  // Debounced copy of `search` that filtering actually uses (300 ms).
  const [query, setQuery] = useState(search.trim());
  const [storedPageSize, setStoredPageSize] = useState<PageSize>(readStoredPageSize);
  const firstRender = useRef(true);

  // --- URL-derived page & page-size -------------------------------------
  const parsedPageSize = Number(searchParams.get('pageSize'));
  const pageSize: PageSize = (PAGE_SIZES as readonly number[]).includes(parsedPageSize)
    ? (parsedPageSize as PageSize)
    : storedPageSize;

  // --- Filtering (search across name + body, then tab) ------------------
  const searched = useMemo(() => {
    if (!query) return templates;
    const needle = query.toLowerCase();
    return templates.filter(
      (tpl) =>
        tpl.name.toLowerCase().includes(needle) ||
        (tpl.body_text ?? '').toLowerCase().includes(needle),
    );
  }, [templates, query]);

  // Tab counts reflect the current search, so the numbers on the tabs
  // always match the rows the tab would show (across all pages).
  const counts = useMemo(() => {
    const out: Record<TabId, number> = { all: searched.length, approved: 0, pending: 0, rejected: 0 };
    for (const tpl of searched) {
      const status = (tpl.status ?? 'DRAFT') as MessageTemplateStatus;
      if (status === 'APPROVED') out.approved++;
      else if (status === 'PENDING') out.pending++;
      else if (status === 'REJECTED') out.rejected++;
    }
    return out;
  }, [searched]);

  // Deterministic newest-first ordering with an id tie-breaker so no row
  // is duplicated or skipped between pages, whatever the incoming order.
  const ordered = useMemo(() => {
    const allowed = TAB_STATUSES[tab];
    const filtered = allowed
      ? searched.filter((tpl) => tpl.status && allowed.includes(tpl.status))
      : searched;
    return [...filtered].sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      if (a.id !== b.id) return a.id < b.id ? 1 : -1;
      return 0;
    });
  }, [searched, tab]);

  // --- Pagination math (clamped) ----------------------------------------
  const total = ordered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const parsedPage = Number(searchParams.get('page'));
  const requestedPage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const safePage = Math.min(requestedPage, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const rows = ordered.slice(startIdx, startIdx + pageSize);
  const rangeStart = total === 0 ? 0 : startIdx + 1;
  const rangeEnd = Math.min(startIdx + pageSize, total);

  // --- URL navigation ----------------------------------------------------
  const buildParams = useCallback(
    (over: { page?: number; pageSize?: PageSize; q?: string; tab?: TabId }) => {
      const p = new URLSearchParams();
      const q = over.q !== undefined ? over.q : query;
      const nextTab = over.tab !== undefined ? over.tab : tab;
      const ps = over.pageSize !== undefined ? over.pageSize : pageSize;
      const pg = over.page !== undefined ? over.page : safePage;
      if (q) p.set('q', q);
      if (nextTab !== 'all') p.set('tab', nextTab);
      p.set('pageSize', String(ps));
      if (pg > 1) p.set('page', String(pg));
      return p;
    },
    [query, tab, pageSize, safePage],
  );

  const navigate = useCallback(
    (params: URLSearchParams, replace: boolean) => {
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      startTransition(() => {
        if (replace) router.replace(url, { scroll: false });
        else router.push(url);
      });
    },
    [pathname, router],
  );

  // Debounce the filter.
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Mirror q/tab into the URL (shallow replace so the back stack doesn't
  // fill with keystrokes) and reset to page 1 — changing a filter always
  // starts at the top of the new result set.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    navigate(buildParams({ page: 1 }), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tab]);

  // Persist the chosen page size for next time (per-browser preference).
  useEffect(() => {
    try {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(storedPageSize));
    } catch {
      /* storage unavailable — preference simply won't persist */
    }
  }, [storedPageSize]);

  // Page-change effect: keep the layout stable, scroll the table top into
  // view and move focus there (with the aria-live announcement below).
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useRef(false);
  const lastPage = useRef(safePage);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
  }, []);
  useEffect(() => {
    if (lastPage.current === safePage) return;
    lastPage.current = safePage;
    const el = tableWrapRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: reducedMotion.current ? 'auto' : 'smooth', block: 'start' });
    el.focus({ preventScroll: true });
  }, [safePage]);

  function handleSearch(value: string) {
    setSearch(value);
  }
  function goToPage(p: number) {
    const target = Math.min(Math.max(1, p), totalPages);
    if (target === safePage) return;
    navigate(buildParams({ page: target }), false);
  }
  function changePageSize(value: string) {
    const n = Number(value);
    if (!(PAGE_SIZES as readonly number[]).includes(n)) return;
    setStoredPageSize(n as PageSize);
    navigate(buildParams({ pageSize: n as PageSize, page: 1 }), false);
  }

  const showPager = total > PAGE_SIZES[0] && totalPages > 1;

  return (
    <div className="space-y-3">
      {/* Search box — magnifier + clear (x) when text is present. */}
      <div className="relative w-full max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={t('searchTemplates')}
          className="bg-card pl-8 pr-8 text-foreground placeholder:text-muted-foreground"
        />
        {search && (
          <button
            type="button"
            onClick={() => handleSearch('')}
            aria-label={t('clearSearchAria')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Status tabs with live counts. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList className="bg-muted/50 border border-border">
          <TabsTrigger value="all" className="data-active:bg-muted data-active:text-primary text-muted-foreground">
            {t('tabAll')} <TabCount n={counts.all} />
          </TabsTrigger>
          <TabsTrigger value="approved" className="data-active:bg-muted data-active:text-primary text-muted-foreground">
            {t('tabApproved')} <TabCount n={counts.approved} />
          </TabsTrigger>
          <TabsTrigger value="pending" className="data-active:bg-muted data-active:text-primary text-muted-foreground">
            {t('tabPending')} <TabCount n={counts.pending} />
          </TabsTrigger>
          <TabsTrigger value="rejected" className="data-active:bg-muted data-active:text-primary text-muted-foreground">
            {t('tabRejected')} <TabCount n={counts.rejected} />
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {total === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            {query ? (
              <>
                <p className="text-sm text-muted-foreground">{t('noSearchMatches')}</p>
                <Button variant="outline" size="sm" onClick={() => handleSearch('')} className="border-border text-muted-foreground hover:bg-muted">
                  <X className="size-3.5" />
                  {t('clearSearch')}
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('noTemplates')}</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div
          ref={tableWrapRef}
          tabIndex={-1}
          className="overflow-hidden rounded-md border border-border outline-none"
        >
          <Table>
            <TableHeader>
              <TableRow className="border-border bg-background/60 hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('colName')}</TableHead>
                <TableHead className="text-muted-foreground">{t('colStatus')}</TableHead>
                <TableHead className="text-muted-foreground">{t('colType')}</TableHead>
                <TableHead className="text-muted-foreground">{t('category')}</TableHead>
                <TableHead className="text-muted-foreground">{t('language')}</TableHead>
                <TableHead className="text-right text-muted-foreground">{t('colActions')}</TableHead>
              </TableRow>
            </TableHeader>
            {/* Remount on page/size change so the new rows fade in; the
                motion-reduce variant drops the animation entirely. */}
            <TableBody
              key={`${safePage}-${pageSize}`}
              className="animate-in fade-in-50 duration-150 motion-reduce:animate-none"
            >
              {rows.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  deletingId={deletingId}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onView={onView}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Screen-reader announcement of the current page after a change. */}
      <p className="sr-only" aria-live="polite">
        {t('pageCount', { page: safePage, total: totalPages })}
      </p>

      {/* Pagination footer: summary + page-size selector + pager. */}
      <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {total === 0
            ? t('showingZero')
            : t('showingPagination', { start: rangeStart, end: rangeEnd, total })}
        </p>

        <div className="flex flex-wrap items-center gap-3">
          {/* Page-size selector (10/25/50/100), remembered in localStorage. */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('rowsPerPage')}</span>
            <Select value={String(pageSize)} onValueChange={(v) => changePageSize(String(v))}>
              <SelectTrigger
                size="sm"
                aria-label={t('rowsPerPage')}
                className="w-[68px] border-border bg-card text-foreground"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border">
                {PAGE_SIZES.map((s) => (
                  <SelectItem
                    key={s}
                    value={String(s)}
                    className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                  >
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {showPager && (
            <>
              {/* Full pager (≥640px): first, prev, numbered + ellipses, next, last. */}
              <nav
                aria-label={t('paginationAria')}
                className="hidden items-center gap-1 sm:flex"
              >
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={safePage <= 1}
                  onClick={() => goToPage(1)}
                  aria-label={t('firstPage')}
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ChevronsLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={safePage <= 1}
                  onClick={() => goToPage(safePage - 1)}
                  aria-label={t('prevPage')}
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {pageItems(safePage, totalPages).map((item, i) =>
                  item === 'gap' ? (
                    <span key={`gap-${i}`} aria-hidden className="px-1 text-muted-foreground">
                      …
                    </span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === safePage ? 'secondary' : 'outline'}
                      size="icon-sm"
                      onClick={() => goToPage(item)}
                      aria-current={item === safePage ? 'page' : undefined}
                      className={
                        item === safePage
                          ? 'border-border bg-primary text-primary-foreground hover:bg-primary'
                          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                      }
                    >
                      {item}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={safePage >= totalPages}
                  onClick={() => goToPage(safePage + 1)}
                  aria-label={t('nextPage')}
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ChevronRight className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={safePage >= totalPages}
                  onClick={() => goToPage(totalPages)}
                  aria-label={t('lastPage')}
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ChevronsRight className="size-4" />
                </Button>
              </nav>

              {/* Compact pager (<640px): Prev · Page 3 of 8 · Next. */}
              <nav aria-label={t('paginationAria')} className="flex items-center gap-2 sm:hidden">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={safePage <= 1}
                  onClick={() => goToPage(safePage - 1)}
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  <ChevronLeft className="size-4" />
                  {t('prevShort')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t('pageCount', { page: safePage, total: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={safePage >= totalPages}
                  onClick={() => goToPage(safePage + 1)}
                  className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                  {t('nextShort')}
                  <ChevronRight className="size-4" />
                </Button>
              </nav>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TabCount({ n }: { n: number }) {
  return (
    <span className="ml-1 inline-flex items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
      {n}
    </span>
  );
}

function TemplateRow({
  template,
  deletingId,
  onEdit,
  onDelete,
  onView,
}: {
  template: MessageTemplate;
  deletingId: string | null;
  onEdit: (t: MessageTemplate) => void;
  onDelete: (t: MessageTemplate) => void;
  onView: (t: MessageTemplate) => void;
}) {
  const t = useTranslations('Settings.templates');
  const statusKey = (template.status ?? 'DRAFT') as MessageTemplateStatus;
  const status = templateStatusConfig[statusKey];
  const rejection = template.rejection_reason || template.submission_error;

  return (
    <TableRow className="border-border hover:bg-muted/50">
      {/* Name — bold, with the body (and footer when present) as the
          secondary lines the old cards showed. */}
      <TableCell className="max-w-[22rem] align-top">
        <p className="font-medium text-foreground">{template.name}</p>
        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{template.body_text}</p>
        {template.footer_text && (
          <p className="mt-0.5 line-clamp-1 text-[11px] italic text-muted-foreground/80">
            {template.footer_text}
          </p>
        )}
      </TableCell>

      {/* Status badge (coloured dot) + quality score + rejection reason. */}
      <TableCell className="align-top">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className={`border text-xs ${status.classes}`}>
            <span aria-hidden className="mr-1.5 size-1.5 rounded-full bg-current" />
            {status.label}
          </Badge>
          {template.quality_score && (
            <span
              className={`text-[10px] font-medium uppercase ${
                template.quality_score === 'GREEN'
                  ? 'text-emerald-400'
                  : template.quality_score === 'YELLOW'
                    ? 'text-yellow-400'
                    : 'text-red-400'
              }`}
              title={t('qualityScoreTitle')}
            >
              {template.quality_score}
            </span>
          )}
        </div>
        {rejection && (
          <p className="mt-1 max-w-[16rem] text-[11px] leading-snug text-red-400" title={rejection}>
            {rejection}
          </p>
        )}
      </TableCell>

      {/* Type — header format with its icon badge. */}
      <TableCell className="align-top">
        <HeaderTypeBadge type={template.header_type ?? 'none'} />
      </TableCell>

      <TableCell className="align-top">
        <Badge className={`border text-xs ${categoryColors[template.category] || ''}`}>
          {template.category}
        </Badge>
      </TableCell>

      <TableCell className="align-top">
        {template.language ? (
          <span className="text-xs text-muted-foreground uppercase">{template.language}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>

      {/* Actions — View template (opens the phone preview), the Edit /
          Resubmit entries the cards offered, and Delete. */}
      <TableCell className="align-top text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onView(template)}
            title={t('viewTemplateTitle')}
            className="h-8 border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Eye className="size-3.5" />
            {t('viewTemplate')}
          </Button>
          {statusKey === 'APPROVED' && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onEdit(template)}
              title={t('editTitle')}
              aria-label={t('editLabel')}
              className="text-muted-foreground hover:bg-primary/10 hover:text-primary"
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
          {(statusKey === 'REJECTED' || statusKey === 'PAUSED') && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onEdit(template)}
              title={t('resubmitTitle')}
              aria-label={t('resubmitLabel')}
              className="text-muted-foreground hover:bg-primary/10 hover:text-primary"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onDelete(template)}
            disabled={deletingId === template.id}
            aria-label={
              template.meta_template_id ? t('deleteMetaLocallyAria') : t('deleteLocallyAria')
            }
            title={
              template.meta_template_id ? t('deleteMetaLocallyTitle') : t('deleteLocallyTitle')
            }
            className="text-red-400 hover:bg-red-950/30 hover:text-red-300"
          >
            {deletingId === template.id ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function HeaderTypeBadge({ type }: { type: NonNullable<MessageTemplate['header_type']> | 'none' }) {
  const t = useTranslations('Settings.templates');
  const map = {
    image: { label: t('headerImage'), icon: ImageIcon },
    video: { label: t('headerVideo'), icon: Video },
    document: { label: t('headerDocument'), icon: FileText },
    text: { label: t('headerText'), icon: TypeIcon },
    none: { label: t('headerNone'), icon: Minus },
  } as const;
  const { label, icon: Icon } = map[type] ?? map.none;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Icon className="size-3" />
      {label}
    </span>
  );
}
