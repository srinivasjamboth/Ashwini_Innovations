'use client';

// ============================================================
// GroupFolderTile — one group as a colored folder on the Groups
// tab (design PART 1–3). The folder is a stack of plain divs in
// three tones from GROUP_COLORS (CSS vars, theme-switched in
// globals.css — no JS theme read, no hydration risk):
//
//   tab  ─ back panel ─ [cards slot] ─ front flap
//
// The cards live BEHIND the front flap (z-order), so on hover they
// slide up out of the folder's mouth and the sliver still inside the
// folder stays covered — the paper-in-a-folder illusion, with no
// masking and only transform/opacity animated.
//
// Mount policy (spec): cards exist only for the hovered/focused tile
// (AnimatePresence per tile, one tile is ever open), and only on
// devices that actually have hover. Touch tiles show the count in the
// caption instead. prefers-reduced-motion → cards just fade.
// ============================================================

import { useCallback, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { ContactGroup } from '@/types';
import {
  folderToneVars,
  resolveGroupColor,
  type GroupColorKey,
} from '@/lib/contacts/group-colors';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Megaphone, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface GroupFolderTileLabels {
  /** Accessible name: "<name>, <count> contacts". */
  openAria: (name: string, count: string) => string;
  /** "Actions for group {name}". */
  menuAria: string;
  edit: string;
  delete: string;
  broadcast: string;
  /** Card 1 eyebrow — static "GROUP" (decorative, aria-hidden). */
  groupEyebrow: string;
  /** Card 2 label + touch caption, singular/plural from i18n. */
  contactsLabel: (count: number) => string;
  /** Fallback label when a group has no name (defensive). */
  unnamed: string;
}

const SPRING = {
  type: 'spring',
  stiffness: 420,
  damping: 30,
  mass: 0.7,
} as const;

/** True on devices that actually have hover. Server/first render
 *  assumes hover (cards only ever mount on pointer/focus entry);
 *  useSyncExternalStore swaps in the real answer without a cascade
 *  render or a hydration mismatch. */
const HOVER_QUERY = '(hover: hover) and (pointer: fine)';

function useHoverCapable(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mq = window.matchMedia(HOVER_QUERY);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const getSnapshot = useCallback(
    () => window.matchMedia(HOVER_QUERY).matches,
    []
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}

export function GroupFolderTile({
  group,
  labels,
  onEdit,
  onDelete,
}: {
  group: ContactGroup;
  labels: GroupFolderTileLabels;
  onEdit: (group: ContactGroup) => void;
  onDelete: (group: ContactGroup) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const hoverCapable = useHoverCapable();
  const reducedMotion = useReducedMotion();
  const colorKey = resolveGroupColor(group.color, group.id);
  const tones = folderToneVars(colorKey);
  const count = group.member_count ?? 0;
  const name = group.name || labels.unnamed;

  const showCards = open && hoverCapable;
  const href = `/contacts/groups/${group.id}`;

  return (
    <div
      className={cn(
        'group relative pt-2 text-center outline-none',
        // A hovered tile must paint its cards over the tiles above it.
        (open || menuOpen) && 'z-20'
      )}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      {/* Everything (folder, menu, caption) shares one centered
          column so the menu sits at the folder's own corner. */}
      <div className="relative mx-auto w-full max-w-[168px]">
        {/* folder illustration (pure divs, three tones) */}
        <Link
          href={href}
          aria-label={labels.openAria(name, count.toLocaleString())}
          className={cn(
            'group-folder relative block aspect-[4/3] w-full overflow-visible',
            'focus-visible:ring-ring focus-visible:ring-offset-background rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-offset-2'
          )}
          style={tones}
        >
          {/* tab */}
          <span
            className="absolute top-[3%] left-[7%] h-[13%] w-[38%] rounded-t-[10px]"
            style={{ background: 'var(--folder-tab)', zIndex: 0 }}
          />
          {/* back panel */}
          <span
            className="absolute inset-x-0 top-[9%] bottom-0 rounded-[12px] shadow-sm"
            style={{ background: 'var(--folder-back)', zIndex: 0 }}
          />

          {/* cards slot — behind the flap so they emerge from the mouth */}
          <span className="absolute inset-x-[-8%] bottom-[52%] z-[1] block h-0">
            <AnimatePresence>
              {showCards && (
                <GroupCards
                  key="group-cards"
                  name={name}
                  count={count}
                  reducedMotion={!!reducedMotion}
                  labels={labels}
                />
              )}
            </AnimatePresence>
          </span>

          {/* front flap — tilts open a few degrees */}
          <motion.span
            className="absolute inset-x-0 bottom-0 z-[2] block h-[72%] rounded-tr-[14px] rounded-b-[12px] shadow-md"
            style={{
              background: 'var(--folder-front)',
              transformOrigin: '6% 100%',
              borderTop: '1px solid rgba(255,255,255,0.18)',
            }}
            animate={
              showCards && !reducedMotion
                ? { rotate: -5, y: -1 }
                : { rotate: 0, y: 0 }
            }
            transition={SPRING}
          />
        </Link>

        {/* row menu — appears on hover / focus / while open */}
        <div
          className={cn(
            'absolute -top-1 -right-1 z-30 transition-opacity duration-150',
            open || menuOpen
              ? 'opacity-100'
              : 'opacity-0 group-focus-within:opacity-100'
          )}
        >
          <DropdownMenu onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground shadow-sm backdrop-blur-xs"
                  aria-label={labels.menuAria}
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="bg-popover border-border"
            >
              <DropdownMenuItem
                onClick={() => onEdit(group)}
                className="text-popover-foreground focus:bg-muted focus:text-foreground"
              >
                <Pencil className="size-4" />
                {labels.edit}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={<Link href={`/broadcasts/new?groupIds=${group.id}`} />}
                className="text-popover-foreground focus:bg-muted focus:text-foreground"
              >
                <Megaphone className="size-4" />
                {labels.broadcast}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete(group)}
              >
                <Trash2 className="size-4" />
                {labels.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* caption — the only info at rest; carries the count on touch */}
        <p
          className="text-muted-foreground mt-2 block truncate px-1 text-sm"
          title={name}
        >
          {hoverCapable
            ? name
            : `${name} · ${count.toLocaleString()} ${labels.contactsLabel(count)}`}
        </p>
      </div>
    </div>
  );
}

/** Static mini-folder in one palette color — the live preview inside
 *  the create/edit panel and the small icon on the group detail
 *  header. Same three tones, same CSS-var bridge, no interaction. */
export function FolderPreview({
  colorKey,
  className,
}: {
  colorKey: GroupColorKey;
  className?: string;
}) {
  return (
    <div
      className={cn('group-folder relative overflow-visible', className)}
      style={folderToneVars(colorKey)}
      aria-hidden
    >
      <span
        className="absolute top-[3%] left-[7%] h-[13%] w-[38%] rounded-t-[10px]"
        style={{ background: 'var(--folder-tab)' }}
      />
      <span
        className="absolute inset-x-0 top-[9%] bottom-0 rounded-[12px]"
        style={{ background: 'var(--folder-back)' }}
      />
      <span
        className="absolute inset-x-0 bottom-0 h-[72%] rounded-tr-[14px] rounded-b-[12px]"
        style={{
          background: 'var(--folder-front)',
          borderTop: '1px solid rgba(255,255,255,0.18)',
        }}
      />
    </div>
  );
}

/** The two fanned cards (spec PART 2): name card low, count card
 *  high, ±6°, 60 ms stagger, spring in and out. Decorative — the same
 *  information is on the link's accessible name and the caption. */
function GroupCards({
  name,
  count,
  reducedMotion,
  labels,
}: {
  name: string;
  count: number;
  reducedMotion: boolean;
  labels: GroupFolderTileLabels;
}) {
  const cardBase =
    'absolute inset-x-0 bottom-0 rounded-lg border border-border bg-card px-3 py-2 text-left shadow-lg';

  const anim = (rotate: number, y: number, delay: number) =>
    reducedMotion
      ? {
          initial: { opacity: 0 },
          animate: { opacity: 1, transition: { duration: 0.15, delay } },
          exit: { opacity: 0, transition: { duration: 0.1, delay: 0 } },
        }
      : {
          initial: { opacity: 0, y: 14, rotate: 0 },
          animate: {
            opacity: 1,
            y,
            rotate,
            transition: { ...SPRING, delay },
          },
          exit: {
            opacity: 0,
            y: 14,
            rotate: 0,
            transition: { ...SPRING, delay: 0 },
          },
        };

  const nameCard = anim(-6, -46, 0);
  const countCard = anim(6, -100, 0.06);

  return (
    <span aria-hidden className="pointer-events-none block">
      <motion.span
        className={cardBase}
        initial={nameCard.initial}
        animate={nameCard.animate}
        exit={nameCard.exit}
      >
        {/* accent line in the folder's color */}
        <span
          className="absolute top-0 right-2 left-2 h-[3px] rounded-b-sm"
          style={{ background: 'var(--folder-front)' }}
        />
        <span className="text-muted-foreground block pt-1 text-[9px] font-semibold tracking-widest uppercase">
          {labels.groupEyebrow}
        </span>
        <span
          className="text-card-foreground line-clamp-2 block text-sm font-bold"
          title={name}
        >
          {name}
        </span>
      </motion.span>
      <motion.span
        className={cardBase}
        initial={countCard.initial}
        animate={countCard.animate}
        exit={countCard.exit}
      >
        <span
          className="absolute top-0 right-2 left-2 h-[3px] rounded-b-sm"
          style={{ background: 'var(--folder-front)' }}
        />
        <span className="text-card-foreground block pt-1 text-2xl font-bold tabular-nums">
          {count.toLocaleString()}
        </span>
        <span className="text-muted-foreground block text-[9px] font-semibold tracking-widest uppercase">
          {labels.contactsLabel(count)}
        </span>
      </motion.span>
    </span>
  );
}
