// Sends one approved outreach draft. Outreach goes out only because a person
// approved this exact text and then pressed Send; this re-checks everything at
// the moment of sending, because lists and flags change after approval.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "@/lib/env.server";
import { bweReader } from "@/lib/bwe-source.server";
import { effectiveSendCap } from "@/lib/agency/rules";
import { checkSuppression } from "@/lib/actions/suppression.server";
import { validateDraft } from "@/lib/actions/draft-validator";
import { composeOutreach, formatMailingAddress } from "@/lib/actions/outreach-message";
import { unsubscribeUrl } from "@/lib/actions/unsubscribe-link.server";
import { MAILING_ADDRESS_MARKER, UNSUBSCRIBE_MARKER } from "@/lib/providers/ai/anthropic.server";
import { DEFAULT_MAIL_SETTINGS, effectiveFrom, type MailSettings } from "@/lib/mail/settings";
import { hostOf } from "@/lib/discovery/url";
import { logBccAddress, sendMail, type MailboxConfig } from "@/lib/providers/mail/smtp.server";

type Db = SupabaseClient<any, any, any>;
export type SendResult = { ok: true; messageId: string; to: string } | { ok: false; reason: string };

export function mailboxFrom(env: ServerEnv): MailboxConfig | null {
  if (!env.LEAD_EMAIL_SMTP_USER || !env.LEAD_EMAIL_SMTP_PASSWORD) return null;
  return { host: env.LEAD_EMAIL_SMTP_HOST || "smtp.gmail.com", port: Number(env.LEAD_EMAIL_SMTP_PORT) || 465, user: env.LEAD_EMAIL_SMTP_USER, pass: env.LEAD_EMAIL_SMTP_PASSWORD };
}

/** The visible sender chosen on the dashboard, or the defaults when nothing was saved. */
export async function loadMailSettings(db: Db, tenantId: string): Promise<MailSettings> {
  const r = await db.from("gie_tenant_mail_settings").select("from_name, from_email, reply_to_email").eq("tenant_id", tenantId).maybeSingle();
  if (r.error) throw new Error(r.error.message);
  return r.data ? { fromName: r.data.from_name, fromEmail: r.data.from_email, replyTo: r.data.reply_to_email } : DEFAULT_MAIL_SETTINGS;
}

export async function sendApprovedDraft(
  env: ServerEnv,
  db: Db,
  tenant: { id: string; slug: string },
  draftId: string,
  actorUserId: string,
  now = new Date(),
  send: typeof sendMail = sendMail,
): Promise<SendResult> {
  const mailbox = mailboxFrom(env);
  if (!mailbox) return { ok: false, reason: "Sending is not set up: LEAD_EMAIL_SMTP_USER and LEAD_EMAIL_SMTP_PASSWORD are missing from this Worker." };
  if (!env.UNSUBSCRIBE_SECRET) return { ok: false, reason: "Sending is not set up: UNSUBSCRIBE_SECRET (the same value BWE uses) is missing from this Worker." };

  const d = await db.from("gie_outreach_drafts").select("id, status, subject, body, follow_up_body, prospect_id").eq("tenant_id", tenant.id).eq("id", draftId).maybeSingle();
  if (d.error) throw new Error(d.error.message);
  if (!d.data) return { ok: false, reason: "That draft does not exist in this workspace." };
  if (d.data.status === "sent") return { ok: false, reason: "This draft was already sent." };
  if (d.data.status !== "approved") return { ok: false, reason: "A person must approve the draft before it can be sent." };

  const p = await db.from("gie_prospects").select("business_name, website_url, contact_email, do_not_contact, opportunity_id").eq("tenant_id", tenant.id).eq("id", d.data.prospect_id).single();
  if (p.error) throw new Error(p.error.message);
  if (p.data.do_not_contact) return { ok: false, reason: "This prospect is marked do-not-contact." };
  if (!p.data.contact_email) return { ok: false, reason: "There is no contact email for this prospect." };
  const to = String(p.data.contact_email).toLowerCase();

  const opp = await db.from("gie_opportunities").select("signal_type").eq("tenant_id", tenant.id).eq("id", p.data.opportunity_id).single();
  if (opp.error) throw new Error(opp.error.message);
  const validation = validateDraft({
    subject: d.data.subject,
    body: d.data.body,
    followUpBody: d.data.follow_up_body,
    signalType: opp.data.signal_type,
    prospect: { businessName: p.data.business_name, websiteHost: p.data.website_url ? hostOf(p.data.website_url) : null },
    unsubscribeMarker: UNSUBSCRIBE_MARKER,
    mailingAddressMarker: MAILING_ADDRESS_MARKER,
  });
  if (!validation.ok) return { ok: false, reason: "The draft no longer passes the checks. Edit it and approve again." };

  const sup = await checkSuppression(env, tenant.slug, to);
  if (!sup.clear) {
    if (sup.listed) await db.from("gie_prospects").update({ do_not_contact: true, do_not_contact_reason: sup.reason }).eq("tenant_id", tenant.id).eq("id", d.data.prospect_id);
    return { ok: false, reason: sup.reason };
  }

  // Daily cap on what leaves the mailbox, whoever presses the button.
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const sentToday = await db.from("gie_outreach_drafts").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id).gte("sent_at", since);
  if (sentToday.error) throw new Error(sentToday.error.message);
  // The app-wide cap always applies; a workspace's own limit can only be lower.
  const quota = await db.from("gie_tenant_quotas").select("daily_send_cap").eq("tenant_id", tenant.id).maybeSingle();
  if (quota.error) throw new Error(quota.error.message);
  const cap = effectiveSendCap(env.GIE_DAILY_SEND_CAP, quota.data?.daily_send_cap);
  if ((sentToday.count ?? 0) >= cap) return { ok: false, reason: `The daily limit of ${cap} sent emails is reached. Try again tomorrow.` };

  // BWE's mailing address (never the physical address), read-only.
  const biz = await bweReader(env).from("business_settings").select("mailing_address, mailing_city, mailing_state, mailing_zip").limit(1).maybeSingle();
  if (biz.error) return { ok: false, reason: "BWE's mailing address could not be read, so nothing can be sent." };
  const mailingAddress = biz.data ? formatMailingAddress(biz.data) : "";
  if (!mailingAddress) return { ok: false, reason: "BWE's mailing address is empty in BWE's business settings, so nothing can be sent." };

  let composed;
  try {
    composed = composeOutreach({ subject: d.data.subject, body: d.data.body, unsubscribeUrl: await unsubscribeUrl(env.UNSUBSCRIBE_SECRET, env.UNSUBSCRIBE_BASE_URL, to), mailingAddress });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "The message could not be put together." };
  }

  const sender = await loadMailSettings(db, tenant.id);
  const shownFrom = effectiveFrom(mailbox.user, sender) ?? mailbox.user;

  // Claim first: only one caller can move approved -> sent, so a double click or a retry never sends twice.
  const claim = await db.from("gie_outreach_drafts").update({ status: "sent", sent_at: now.toISOString(), sent_message_id: "pending", sent_from: shownFrom, send_error: null }).eq("tenant_id", tenant.id).eq("id", d.data.id).eq("status", "approved").select("id");
  if (claim.error) throw new Error(claim.error.message);
  if (!claim.data?.length) return { ok: false, reason: "The draft changed while sending. Reload and check its status." };

  try {
    const { messageId } = await send(mailbox, {
      fromName: sender.fromName,
      fromEmail: sender.fromEmail ?? undefined,
      replyTo: sender.replyTo ?? undefined,
      to,
      bcc: logBccAddress(mailbox.user, env.GIE_DB_SCHEMA),
      subject: composed.subject,
      text: composed.text,
      headers: composed.headers,
    });
    await db.from("gie_outreach_drafts").update({ sent_message_id: messageId }).eq("tenant_id", tenant.id).eq("id", d.data.id);
    await db.from("gie_audit_events").insert({ tenant_id: tenant.id, actor_user_id: actorUserId, action: "draft.send", entity_type: "outreach_draft", entity_id: d.data.id, after: { to, message_id: messageId } });
    // A reminder to follow up if there is no reply; the person decides what to do on the day.
    const due = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    await db.from("gie_follow_up_tasks").insert({ tenant_id: tenant.id, prospect_id: d.data.prospect_id, due_date: due, note: "No reply yet. Decide whether to follow up." });
    return { ok: true, messageId, to };
  } catch (e) {
    // Not sent: put it back so a person can try again.
    const message = (e instanceof Error ? e.message : "Send failed").slice(0, 400);
    await db.from("gie_outreach_drafts").update({ status: "approved", sent_at: null, sent_message_id: null, sent_from: null, send_error: message }).eq("tenant_id", tenant.id).eq("id", d.data.id);
    console.error("[send] failed", message);
    return { ok: false, reason: `The email was not sent: ${message}` };
  }
}
