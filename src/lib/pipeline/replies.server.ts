// Reply detection. Reads the lead mailbox INBOX read-only (nothing is marked read,
// moved or deleted), matches messages to sent outreach, records them, and
// stops follow-ups for a prospect who answered. A bounce marks the address
// do-not-contact. Runs from the 15-minute cron.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "@/lib/env.server";
import { serviceClient } from "@/lib/supabase.server";
import { findMessagesFrom, type FetchedMessage } from "@/lib/providers/mail/imap.server";

type Db = SupabaseClient<any, any, any>;
const WINDOW_DAYS = 30;
const MAX_PROSPECTS_PER_RUN = 40;

export type ReplyKind = "reply" | "auto_reply" | "bounce";

/** What an inbound message is. Pure. */
export function classifyReply(m: Pick<FetchedMessage, "from" | "subject" | "autoSubmitted">): ReplyKind {
  if (/^(mailer-daemon|postmaster)@/i.test(m.from) || /^(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail)/i.test(m.subject.trim())) return "bounce";
  if (m.autoSubmitted || /^(automatic reply|auto[- ]?reply|out of office)/i.test(m.subject.trim())) return "auto_reply";
  return "reply";
}

/** Mailbox quoting/encoding noise out of the first part of a text body. Pure. */
export function snippetOf(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith(">") && !/^On .+ wrote:$/i.test(l.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

type SentRow = { id: string; prospect_id: string; sent_at: string; sent_message_id: string; prospect: { contact_email: string } | null };

/** Match inbound messages to sent drafts by sender; a message older than the send is not a reply. Pure. */
export function matchReplies(sent: SentRow[], messages: FetchedMessage[]): Array<{ draft: SentRow; message: FetchedMessage; kind: ReplyKind; messageId: string }> {
  const out: Array<{ draft: SentRow; message: FetchedMessage; kind: ReplyKind; messageId: string }> = [];
  for (const m of messages) {
    if (!m.messageId) continue;
    const kind = classifyReply(m);
    // A bounce names our message in its body or References, not its own sender.
    const draft =
      kind === "bounce"
        ? sent.find((s) => (m.references ?? "").includes(s.sent_message_id) || m.text.includes(s.sent_message_id) || m.text.toLowerCase().includes(s.prospect?.contact_email?.toLowerCase() ?? "\u0000"))
        : sent.find((s) => s.prospect?.contact_email?.toLowerCase() === m.from && (!m.date || m.date.getTime() >= new Date(s.sent_at).getTime() - 60_000));
    if (draft) out.push({ draft, message: m, kind, messageId: m.messageId });
  }
  return out;
}

export async function syncReplies(
  env: ServerEnv,
  db: Db,
  tenantId: string,
  now = new Date(),
  fetchMessages: typeof findMessagesFrom = findMessagesFrom,
): Promise<{ checked: number; recorded: number; skipped?: string }> {
  const user = env.EMAIL_LOG_IMAP_USER || env.LEAD_EMAIL_SMTP_USER;
  const pass = env.EMAIL_LOG_IMAP_PASSWORD || env.LEAD_EMAIL_SMTP_PASSWORD;
  if (!user || !pass) return { checked: 0, recorded: 0, skipped: "Mailbox login is not set on this Worker." };

  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await db
    .from("gie_outreach_drafts")
    .select("id, prospect_id, sent_at, sent_message_id, prospect:gie_prospects(contact_email)")
    .eq("tenant_id", tenantId)
    .eq("status", "sent")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(MAX_PROSPECTS_PER_RUN);
  if (rows.error) throw new Error(rows.error.message);
  const sent = ((rows.data ?? []) as unknown as SentRow[]).filter((r) => r.prospect?.contact_email);
  if (sent.length === 0) return { checked: 0, recorded: 0 };

  const imapHost = env.LEAD_EMAIL_IMAP_HOST || (env.LEAD_EMAIL_SMTP_HOST || "smtp.gmail.com").replace(/^smtp\./i, "imap.");
  const addresses = [...new Set(sent.map((s) => s.prospect!.contact_email.toLowerCase()))];
  // Bounces come from the mail system, not the prospect.
  const messages = [...(await fetchMessages({ host: imapHost, user, pass }, addresses, WINDOW_DAYS, now)), ...(await fetchMessages({ host: imapHost, user, pass }, ["mailer-daemon"], WINDOW_DAYS, now))];

  let recorded = 0;
  for (const hit of matchReplies(sent, messages)) {
    const ins = await db
      .from("gie_outreach_replies")
      .upsert(
        {
          tenant_id: tenantId,
          prospect_id: hit.draft.prospect_id,
          draft_id: hit.draft.id,
          message_id: hit.messageId.slice(0, 300),
          in_reply_to: hit.message.inReplyTo?.slice(0, 600) ?? null,
          from_email: hit.message.from.slice(0, 254),
          subject: hit.message.subject.slice(0, 300),
          snippet: snippetOf(hit.message.text),
          kind: hit.kind,
          received_at: (hit.message.date ?? now).toISOString(),
        },
        { onConflict: "tenant_id,message_id", ignoreDuplicates: true },
      )
      .select("id");
    if (ins.error) throw new Error(ins.error.message);
    if (!ins.data?.length) continue; // already recorded
    recorded++;
    if (hit.kind === "bounce") {
      await db.from("gie_prospects").update({ do_not_contact: true, do_not_contact_reason: "Email bounced" }).eq("tenant_id", tenantId).eq("id", hit.draft.prospect_id);
    }
    if (hit.kind === "reply") {
      // They answered: stop reminding anyone to chase them.
      await db.from("gie_follow_up_tasks").update({ status: "cancelled" }).eq("tenant_id", tenantId).eq("prospect_id", hit.draft.prospect_id).eq("status", "open");
    }
  }
  return { checked: addresses.length, recorded };
}

export async function runReplyTick(env: ServerEnv, now = new Date()): Promise<Array<{ tenant: string; step: string; detail: string }>> {
  const db = serviceClient(env, env.GIE_DB_SCHEMA);
  const log: Array<{ tenant: string; step: string; detail: string }> = [];
  const t = await db.from("gie_tenants").select("id, slug").eq("status", "active");
  if (t.error) throw new Error(t.error.message);
  for (const tenant of t.data ?? []) {
    // Only the BWE workspace has a connected mailbox.
    if (tenant.slug !== env.BWE_TENANT_SLUG) continue;
    try {
      const r = await syncReplies(env, db, tenant.id, now);
      if (r.skipped) log.push({ tenant: tenant.slug, step: "replies", detail: r.skipped });
      else if (r.recorded > 0) log.push({ tenant: tenant.slug, step: "replies", detail: `${r.recorded} new from ${r.checked} prospects` });
    } catch (e) {
      log.push({ tenant: tenant.slug, step: "replies", detail: `failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}` });
    }
  }
  return log;
}
