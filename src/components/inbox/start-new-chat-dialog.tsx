"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { MessageSquarePlus, UserRound, Users, Loader2 } from "lucide-react";
import type { Conversation } from "@/types";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ChatInput {
  name?: string | null;
  phone: string;
}

interface StartNewChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the first created conversation so the inbox can open it. */
  onCreated: (conversation: Conversation) => void;
}

// A small, editable set of dial codes. India (+91) is the default to
// match the reference; numbers typed with an explicit leading `+` always
// win over the selector.
const COUNTRY_CODES: { code: string; dial: string }[] = [
  { code: "IN", dial: "+91" },
  { code: "US", dial: "+1" },
  { code: "CA", dial: "+1" },
  { code: "GB", dial: "+44" },
  { code: "AE", dial: "+971" },
  { code: "SA", dial: "+966" },
  { code: "PK", dial: "+92" },
  { code: "BD", dial: "+880" },
  { code: "NG", dial: "+234" },
  { code: "KE", dial: "+254" },
  { code: "ZA", dial: "+27" },
  { code: "ID", dial: "+62" },
  { code: "PH", dial: "+63" },
  { code: "MY", dial: "+60" },
  { code: "SG", dial: "+65" },
  { code: "AU", dial: "+61" },
  { code: "DE", dial: "+49" },
  { code: "FR", dial: "+33" },
  { code: "BR", dial: "+55" },
  { code: "MX", dial: "+52" },
];

/**
 * Combine a dial code + the typed national number into an E.164 string.
 * A number that already starts with `+` is used verbatim (the caller
 * knows the country better than our default selector does).
 */
function composePhone(dial: string, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return trimmed;
  return `${dial}${trimmed.replace(/\D/g, "")}`;
}

/** Parse the bulk textarea into name/phone pairs, one per line. */
function parseBulk(text: string, dial: string): ChatInput[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const comma = line.indexOf(",");
      if (comma >= 0) {
        return {
          name: line.slice(0, comma).trim() || null,
          phone: composePhone(dial, line.slice(comma + 1)),
        };
      }
      return { name: null, phone: composePhone(dial, line) };
    });
}

export function StartNewChatDialog({
  open,
  onOpenChange,
  onCreated,
}: StartNewChatDialogProps) {
  const t = useTranslations("Inbox.startNewChat");

  const [tab, setTab] = useState<"single" | "bulk">("single");
  const [dial, setDial] = useState("+91");
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [bulk, setBulk] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Clear the form each time the dialog is dismissed so reopening starts
  // fresh (and a half-typed bulk list doesn't linger).
  useEffect(() => {
    if (!open) {
      setTab("single");
      setDial("+91");
      setName("");
      setNumber("");
      setBulk("");
      setSubmitting(false);
    }
  }, [open]);

  async function handleSubmit() {
    if (submitting) return;

    const chats: ChatInput[] =
      tab === "single"
        ? [{ name: name.trim() || null, phone: composePhone(dial, number) }]
        : parseBulk(bulk, dial);

    // Client-side sanity checks before hitting the network.
    if (tab === "single") {
      const digits = chats[0].phone.replace(/\D/g, "");
      if (digits.length < 8) {
        toast.error(t("errNumberRequired"));
        return;
      }
    } else if (chats.length === 0) {
      toast.error(t("errBulkEmpty"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/inbox/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chats }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        toast.error(data?.error || t("toastFailed"));
        return;
      }

      const created: Conversation[] = data?.conversations ?? [];
      if (created.length === 0) {
        toast.error(t("toastFailed"));
        return;
      }

      // Open the first newly-created thread; the rest surface in the list
      // via the realtime INSERT events.
      onCreated(created[0]);

      if (tab === "bulk" || created.length > 1) {
        toast.success(t("toastCreatedBulk", { count: created.length }));
      } else {
        toast.success(t("toastCreated"));
      }
      onOpenChange(false);
    } catch {
      toast.error(t("toastFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="flex-row items-center gap-3 space-y-0">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MessageSquarePlus className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="text-lg">{t("title")}</DialogTitle>
            <DialogDescription className="mt-0.5">
              {t("description")}
            </DialogDescription>
          </div>
        </DialogHeader>

        {/* Tabs: Single Chat / Bulk Chat */}
        <div className="flex items-center gap-6 border-b border-border">
          <button
            type="button"
            onClick={() => setTab("single")}
            className={cn(
              "relative -mb-px flex items-center gap-2 border-b-2 px-1 py-2.5 text-sm font-medium transition-colors",
              tab === "single"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <UserRound className="h-4 w-4" />
            {t("tabSingle")}
          </button>
          <button
            type="button"
            onClick={() => setTab("bulk")}
            className={cn(
              "relative -mb-px flex items-center gap-2 border-b-2 px-1 py-2.5 text-sm font-medium transition-colors",
              tab === "bulk"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Users className="h-4 w-4" />
            {t("tabBulk")}
          </button>
        </div>

        {tab === "single" ? (
          <div className="space-y-4 pt-1">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                {t("nameLabel")}
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                {t("numberLabel")}
              </label>
              <div className="flex items-center gap-2">
                <select
                  value={dial}
                  onChange={(e) => setDial(e.target.value)}
                  aria-label={t("numberLabel")}
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary/50"
                >
                  {COUNTRY_CODES.map((c) => (
                    <option key={`${c.code}${c.dial}`} value={c.dial}>
                      {c.code} {c.dial}
                    </option>
                  ))}
                </select>
                <Input
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  inputMode="tel"
                  placeholder={t("numberPlaceholder")}
                  className="flex-1"
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5 pt-1">
            <label className="text-sm font-medium text-foreground">
              {t("bulkLabel")}
            </label>
            <textarea
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              rows={6}
              placeholder={t("bulkPlaceholder")}
              className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
            />
          </div>
        )}

        <div className="mt-2 flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {tab === "bulk" ? t("createBulk") : t("create")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
