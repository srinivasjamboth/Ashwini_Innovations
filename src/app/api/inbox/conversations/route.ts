import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { findExistingContact, isUniqueViolation } from "@/lib/contacts/dedupe";
import { parseInternationalPhone } from "@/lib/whatsapp/phone-utils";
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from "@/lib/inbox/conversations";
import type { Conversation } from "@/types";

// ============================================================
// "Start New Chat" — find-or-create a contact + conversation for a
// phone number (or a batch of them) and hand the full conversation
// row back so the inbox can open it immediately.
//
// This deliberately reuses the exact primitives the outbound-send
// route and the inbound webhook use:
//   - `parseInternationalPhone`  → E.164 validation (leading + required)
//   - `findExistingContact`      → the shared last-8-digit dedupe lookup
//   - one conversation per (account, contact), oldest-first, with the
//     23505 unique-index race handled the same way as the webhook
// so a chat started from the UI is indistinguishable from one created
// by an inbound message. Everything runs under the caller's RLS via
// `requireRole('agent')` — the same account-membership policies the
// send route already relies on for its conversation INSERT.
// ============================================================

interface ChatInput {
  name?: string | null;
  phone?: string;
}

// Guard against an unbounded bulk payload; well above any real use.
const MAX_CHATS_PER_REQUEST = 500;

type RawConv = Parameters<typeof normalizeConversation>[0];

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole("agent");

    const body = await request.json().catch(() => null);
    const chats: ChatInput[] = Array.isArray(body?.chats) ? body.chats : [];
    if (chats.length === 0) {
      return NextResponse.json({ error: "No chats provided" }, { status: 400 });
    }
    if (chats.length > MAX_CHATS_PER_REQUEST) {
      return NextResponse.json(
        { error: "Too many chats in one request" },
        { status: 400 },
      );
    }

    const created: Conversation[] = [];
    const errors: { phone: string; reason: string }[] = [];

    for (const chat of chats) {
      const rawPhone = (chat.phone ?? "").trim();
      const sanitized = parseInternationalPhone(rawPhone);
      if (!sanitized) {
        errors.push({ phone: rawPhone, reason: "invalid_phone" });
        continue;
      }
      const e164 = `+${sanitized}`;
      const name = (chat.name ?? "").trim() || null;

      // ---- contact: find-or-create ----------------------------
      let contactId: string | null = null;
      const existing = await findExistingContact(supabase, accountId, e164);
      if (existing) {
        contactId = existing.id;
        if (name && name !== existing.name) {
          await supabase
            .from("contacts")
            .update({ name, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
        }
      } else {
        const { data, error } = await supabase
          .from("contacts")
          .insert({
            account_id: accountId,
            user_id: userId,
            phone: e164,
            name: name || e164,
          })
          .select("id")
          .single();

        if (data) {
          contactId = data.id;
        } else if (isUniqueViolation(error)) {
          // Lost a race with a concurrent create — re-resolve.
          const raced = await findExistingContact(supabase, accountId, e164);
          if (raced) contactId = raced.id;
        }
      }
      if (!contactId) {
        errors.push({ phone: rawPhone, reason: "contact_failed" });
        continue;
      }

      // ---- conversation: find-or-create -----------------------
      let conversationId: string | null = null;
      const { data: existingConv } = await supabase
        .from("conversations")
        .select("id")
        .eq("account_id", accountId)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: true })
        .limit(1);
      if (existingConv && existingConv.length > 0) {
        conversationId = existingConv[0].id;
      } else {
        const { data: newConv, error: convErr } = await supabase
          .from("conversations")
          .insert({
            account_id: accountId,
            user_id: userId,
            contact_id: contactId,
          })
          .select("id")
          .single();

        if (newConv) {
          conversationId = newConv.id;
        } else if (isUniqueViolation(convErr)) {
          const { data: raced } = await supabase
            .from("conversations")
            .select("id")
            .eq("account_id", accountId)
            .eq("contact_id", contactId)
            .order("created_at", { ascending: true })
            .limit(1);
          if (raced && raced.length > 0) conversationId = raced[0].id;
        }
      }
      if (!conversationId) {
        errors.push({ phone: rawPhone, reason: "conversation_failed" });
        continue;
      }

      // Return the full row (contact joined) so the client can open it
      // without waiting for the realtime INSERT to land.
      const { data: full } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .eq("id", conversationId)
        .maybeSingle();
      if (full) created.push(normalizeConversation(full as RawConv));
    }

    return NextResponse.json({ conversations: created, errors });
  } catch (error) {
    return toErrorResponse(error);
  }
}
