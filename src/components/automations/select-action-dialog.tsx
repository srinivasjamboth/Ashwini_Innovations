"use client"

import { useTranslations } from "next-intl"
import { MessageSquare, Zap } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  ACTIONS_TAB_TYPES,
  AUTOMATION_NODE_META,
  MESSAGES_TAB_TYPES,
  type PaletteNodeType,
} from "@/lib/automations/graph-types"
import { cn } from "@/lib/utils"

// ------------------------------------------------------------
// "Select Action" — the n8n-style palette modal. Opens when a
// connection drag is released on empty canvas; picking a card
// creates that node at the drop point and wires it to the dragged
// handle (the builder shell owns both API calls).
// ------------------------------------------------------------

interface SelectActionDialogProps {
  open: boolean
  onClose: () => void
  onPick: (type: PaletteNodeType) => void
}

export function SelectActionDialog({ open, onClose, onPick }: SelectActionDialogProps) {
  const t = useTranslations("Automations.builder")

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl border-border bg-card">
        <DialogHeader>
          <DialogTitle className="pr-8 text-sm font-semibold">
            {t("selectAction.title")}
          </DialogTitle>
        </DialogHeader>
        {/* DialogContent's built-in close X (top-right) satisfies the spec. */}

        <Tabs defaultValue="messages">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="messages" className="gap-1.5">
              <MessageSquare className="h-3.5 w-3.5" />
              {t("selectAction.tabMessages")}
            </TabsTrigger>
            <TabsTrigger value="actions" className="gap-1.5">
              <Zap className="h-3.5 w-3.5" />
              {t("selectAction.tabActions")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="messages" className="mt-3">
            <ActionGrid types={MESSAGES_TAB_TYPES} onPick={onPick} t={t} />
          </TabsContent>
          <TabsContent value="actions" className="mt-3">
            <ActionGrid types={ACTIONS_TAB_TYPES} onPick={onPick} t={t} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function ActionGrid({
  types,
  onPick,
  t,
}: {
  types: PaletteNodeType[]
  onPick: (type: PaletteNodeType) => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <ScrollArea className="max-h-[380px] pr-3">
      <div className="grid grid-cols-2 gap-2">
        {types.map((type) => {
          const meta = AUTOMATION_NODE_META[type]
          const Icon = meta.icon
          return (
            <button
              key={type}
              type="button"
              onClick={() => onPick(type)}
              className={cn(
                "flex items-start gap-3 rounded-lg border border-border bg-background p-3 text-left",
                "transition-colors hover:border-primary hover:bg-primary/5",
              )}
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                  CHIP_CLASS[meta.color] ?? "bg-muted text-muted-foreground",
                )}
                aria-hidden
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {t(`nodeTypes.${meta.labelKey}.label`)}
                </span>
                <span className="mt-0.5 block text-[11px] leading-tight text-muted-foreground">
                  {t(`nodeTypes.${meta.labelKey}.description`)}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </ScrollArea>
  )
}

// Static class map — Tailwind can't see dynamically composed class
// names, so every hue used by AUTOMATION_NODE_META gets a literal entry.
const CHIP_CLASS: Record<string, string> = {
  blue: "bg-blue-500/10 text-blue-400",
  emerald: "bg-emerald-500/10 text-emerald-400",
  violet: "bg-violet-500/10 text-violet-400",
  fuchsia: "bg-fuchsia-500/10 text-fuchsia-400",
  teal: "bg-teal-500/10 text-teal-400",
  indigo: "bg-indigo-500/10 text-indigo-400",
  amber: "bg-amber-500/10 text-amber-400",
  cyan: "bg-cyan-500/10 text-cyan-400",
  orange: "bg-orange-500/10 text-orange-400",
  sky: "bg-sky-500/10 text-sky-400",
  green: "bg-green-500/10 text-green-400",
  rose: "bg-rose-500/10 text-rose-400",
  slate: "bg-slate-500/10 text-slate-400",
}
