// Server functions for the Daily Action Center. Reads and simple edits use the
// caller's token (RLS). Approving a draft is a server function: it re-runs the
// validator and the unsubscribe/suppression check first, because approval is
// what allows a person-approved email to be sent later. Nothing here sends.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./auth-middleware";
import { requireTenantRole, SlugInput } from "./tenant-access.server";
import { serviceClient } from "./supabase.server";
import { hasRole } from "./roles";
import { localMoment } from "./schedule";
import { validateDraft, type DraftValidation } from "./actions/draft-validator";
import { MAILING_ADDRESS_MARKER, UNSUBSCRIBE_MARKER } from "./providers/ai/anthropic.server";
import { hostOf } from "./discovery/url";
import { checkSuppression } from "./actions/suppression.server";
import { runMorningPackage } from "./pipeline/package.server";
import { sendApprovedDraft } from "./pipeline/send.server";

const STATUSES = ["not_started", "in_progress", "completed", "deferred", "blocked", "awaiting_response", "cancelled"] as const;

export type ActionItem = {
  id: string;
  rank: number;
  kind: "follow_up" | "opportunity";
  status: (typeof STATUSES)[number];
  recommendedAction: string;
  effort: string;
  importance: number;
  opportunity: { id: string; businessName: string; websiteUrl: string | null; sourceUrl: string; score: number | null; band: string | null; signalType: string } | null;
  followUp: { id: string; dueDate: string; note: string | null } | null;
  prospect: { id: string; businessName: string; contactEmail: string | null; doNotContact: boolean } | null;
  draft: { id: string; subject: string; body: string; followUpBody: string | null; status: string; validation: DraftValidation; editedByPerson: boolean; sentAt: string | null; sendError: string | null } | null;
};

export type DailyPackageView = {
  localDate: string;
  generated: { at: string; late: boolean } | null;
  items: ActionItem[];
  canAct: boolean;
  canApprove: boolean;
};

export const getDailyPackage = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput }).parse(d))
  .handler(async ({ data, context }): Promise<DailyPackageView> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "viewer");
    const db = context.supabase;
    const localDate = localMoment(new Date(), tenant.timezone).date;
    const canAct = hasRole(tenant.role, "operator");
    const pkg = await db.from("gie_daily_action_packages").select("id, generated_at, late").eq("tenant_id", tenant.tenantId).eq("local_date", localDate).maybeSingle();
    if (pkg.error) throw new Error(pkg.error.message);
    if (!pkg.data) return { localDate, generated: null, items: [], canAct, canApprove: canAct };

    const rows = await db.from("gie_daily_action_items").select("*").eq("tenant_id", tenant.tenantId).eq("package_id", pkg.data.id).order("rank");
    if (rows.error) throw new Error(rows.error.message);
    const items = (rows.data ?? []) as any[];
    const ids = (k: string) => [...new Set(items.map((i) => i[k]).filter(Boolean))] as string[];
    const [opps, fus, prospects, scores] = await Promise.all([
      ids("opportunity_id").length ? db.from("gie_opportunities").select("id, business_name, website_url, source_url, latest_score, latest_band, signal_type").eq("tenant_id", tenant.tenantId).in("id", ids("opportunity_id")) : { data: [], error: null },
      ids("follow_up_id").length ? db.from("gie_follow_up_tasks").select("id, due_date, note").eq("tenant_id", tenant.tenantId).in("id", ids("follow_up_id")) : { data: [], error: null },
      ids("prospect_id").length ? db.from("gie_prospects").select("id, business_name, contact_email, do_not_contact").eq("tenant_id", tenant.tenantId).in("id", ids("prospect_id")) : { data: [], error: null },
      { data: [], error: null },
    ]);
    for (const r of [opps, fus, prospects, scores]) if (r.error) throw new Error(r.error.message);
    // Drafts are visible to operators and up (RLS); viewers get none.
    const drafts = canAct && ids("prospect_id").length
      ? await db.from("gie_outreach_drafts").select("id, prospect_id, subject, body, follow_up_body, status, validation, edited_by_person, sent_at, send_error").eq("tenant_id", tenant.tenantId).in("prospect_id", ids("prospect_id")).in("status", ["draft", "approved", "sent"]).order("created_at", { ascending: false })
      : { data: [], error: null };
    if (drafts.error) throw new Error(drafts.error.message);

    const by = <T extends { id: string }>(list: T[] | null) => new Map((list ?? []).map((x) => [x.id, x]));
    const oppBy = by(opps.data as any[]);
    const fuBy = by(fus.data as any[]);
    const pBy = by(prospects.data as any[]);
    const draftBy = new Map<string, any>();
    for (const d of (drafts.data ?? []) as any[]) if (!draftBy.has(d.prospect_id)) draftBy.set(d.prospect_id, d);

    return {
      localDate,
      generated: { at: pkg.data.generated_at, late: pkg.data.late },
      canAct,
      canApprove: canAct,
      items: items.map((i): ActionItem => {
        const o = i.opportunity_id ? (oppBy.get(i.opportunity_id) as any) : null;
        const f = i.follow_up_id ? (fuBy.get(i.follow_up_id) as any) : null;
        const p = i.prospect_id ? (pBy.get(i.prospect_id) as any) : null;
        const d = i.prospect_id ? (draftBy.get(i.prospect_id) as any) : null;
        return {
          id: i.id,
          rank: i.rank,
          kind: i.kind,
          status: i.status,
          recommendedAction: i.recommended_action,
          effort: i.effort,
          importance: i.importance,
          opportunity: o ? { id: o.id, businessName: o.business_name, websiteUrl: o.website_url, sourceUrl: o.source_url, score: o.latest_score, band: o.latest_band, signalType: o.signal_type } : null,
          followUp: f ? { id: f.id, dueDate: f.due_date, note: f.note } : null,
          prospect: p ? { id: p.id, businessName: p.business_name, contactEmail: p.contact_email, doNotContact: p.do_not_contact } : null,
          draft: d ? { id: d.id, subject: d.subject, body: d.body, followUpBody: d.follow_up_body, status: d.status, validation: d.validation, editedByPerson: d.edited_by_person, sentAt: d.sent_at, sendError: d.send_error } : null,
        };
      }),
    };
  });

export const setItemStatus = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, itemId: z.string().uuid(), status: z.enum(STATUSES), note: z.string().trim().max(300).optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const db = context.supabase;
    const prev = await db.from("gie_daily_action_items").select("status").eq("tenant_id", tenant.tenantId).eq("id", data.itemId).maybeSingle();
    if (prev.error) throw new Error(prev.error.message);
    if (!prev.data) throw new Error("Not found: that action does not exist in this workspace.");
    const upd = await db.from("gie_daily_action_items").update({ status: data.status }).eq("tenant_id", tenant.tenantId).eq("id", data.itemId).select("id");
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data?.length) throw new Error("Forbidden: the change was not allowed.");
    const ev = await db.from("gie_daily_action_events").insert({ tenant_id: tenant.tenantId, item_id: data.itemId, actor_user_id: context.userId, event_type: "status_changed", from_status: prev.data.status, to_status: data.status, detail: data.note ? { note: data.note } : null });
    if (ev.error) throw new Error(ev.error.message);
    return { ok: true };
  });

/** Wording edits by a person. The old validation is dropped: approval re-validates. */
export const editDraft = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, draftId: z.string().uuid(), subject: z.string().trim().min(1).max(200), body: z.string().min(1).max(6000), followUpBody: z.string().max(4000).nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const db = context.supabase;
    const cur = await db.from("gie_outreach_drafts").select("status").eq("tenant_id", tenant.tenantId).eq("id", data.draftId).maybeSingle();
    if (cur.error) throw new Error(cur.error.message);
    if (!cur.data) throw new Error("Not found: that draft does not exist in this workspace.");
    if (cur.data.status !== "draft") throw new Error("Invalid: only an unapproved draft can be edited.");
    const upd = await db.from("gie_outreach_drafts").update({ subject: data.subject, body: data.body, follow_up_body: data.followUpBody, edited_by_person: true }).eq("tenant_id", tenant.tenantId).eq("id", data.draftId).select("id");
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data?.length) throw new Error("Forbidden: the change was not allowed.");
    return { ok: true };
  });

/**
 * A person approves the draft as it now reads. The server re-validates it,
 * checks BWE's unsubscribe and suppression lists (failing closed when they
 * cannot be read), and records who approved. It does not send.
 */
export const approveDraft = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, draftId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true } | { ok: false; reason: string; validation?: DraftValidation }> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const svc = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    const d = await svc.from("gie_outreach_drafts").select("id, status, subject, body, follow_up_body, prospect_id").eq("tenant_id", tenant.tenantId).eq("id", data.draftId).maybeSingle();
    if (d.error) throw new Error(d.error.message);
    if (!d.data) throw new Error("Not found: that draft does not exist in this workspace.");
    if (d.data.status !== "draft") return { ok: false, reason: `This draft is already ${d.data.status}.` };
    const p = await svc.from("gie_prospects").select("business_name, website_url, contact_email, do_not_contact, opportunity_id").eq("tenant_id", tenant.tenantId).eq("id", d.data.prospect_id).single();
    if (p.error) throw new Error(p.error.message);
    if (p.data.do_not_contact) return { ok: false, reason: "This prospect is marked do-not-contact." };
    if (!p.data.contact_email) return { ok: false, reason: "There is no contact email for this prospect." };
    const opp = await svc.from("gie_opportunities").select("signal_type").eq("tenant_id", tenant.tenantId).eq("id", p.data.opportunity_id).single();
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
    await svc.from("gie_outreach_drafts").update({ validation }).eq("tenant_id", tenant.tenantId).eq("id", d.data.id);
    if (!validation.ok) return { ok: false, reason: "The draft has problems that must be fixed first.", validation };

    const sup = await checkSuppression(context.env, tenant.slug, p.data.contact_email);
    if (!sup.clear) {
      // Remember it, so the prospect is never ranked or approved again.
      if (sup.listed) await svc.from("gie_prospects").update({ do_not_contact: true, do_not_contact_reason: sup.reason }).eq("tenant_id", tenant.tenantId).eq("id", d.data.prospect_id);
      return { ok: false, reason: sup.reason };
    }

    const upd = await svc.from("gie_outreach_drafts").update({ status: "approved", approved_by: context.userId, approved_at: new Date().toISOString() }).eq("tenant_id", tenant.tenantId).eq("id", d.data.id).eq("status", "draft").select("id");
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data?.length) return { ok: false, reason: "The draft changed while approving. Reload and try again." };
    await svc.from("gie_audit_events").insert({ tenant_id: tenant.tenantId, actor_user_id: context.userId, action: "draft.approve", entity_type: "outreach_draft", entity_id: d.data.id, after: { to: p.data.contact_email } });
    return { ok: true };
  });

export const discardDraft = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, draftId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const svc = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    const upd = await svc.from("gie_outreach_drafts").update({ status: "discarded" }).eq("tenant_id", tenant.tenantId).eq("id", data.draftId).in("status", ["draft", "approved"]).select("id");
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data?.length) throw new Error("Not found: no open draft with that id in this workspace.");
    return { ok: true };
  });

export const setDoNotContact = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, prospectId: z.string().uuid(), reason: z.string().trim().min(1).max(300) }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const upd = await context.supabase.from("gie_prospects").update({ do_not_contact: true, do_not_contact_reason: data.reason }).eq("tenant_id", tenant.tenantId).eq("id", data.prospectId).select("id");
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data?.length) throw new Error("Not found: that prospect does not exist in this workspace.");
    const svc = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    // Any live draft for them is withdrawn at once.
    await svc.from("gie_outreach_drafts").update({ status: "discarded" }).eq("tenant_id", tenant.tenantId).eq("prospect_id", data.prospectId).in("status", ["draft", "approved"]);
    await svc.from("gie_audit_events").insert({ tenant_id: tenant.tenantId, actor_user_id: context.userId, action: "prospect.do_not_contact", entity_type: "prospect", entity_id: data.prospectId, after: { reason: data.reason } });
    return { ok: true };
  });

/** Schedules a follow-up on a prospect, a number of workspace-local days from today (a person's choice). */
export const addFollowUp = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, prospectId: z.string().uuid(), inDays: z.number().int().min(1).max(90), note: z.string().trim().max(500).optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    // Counted in the workspace's own calendar days, so DST and time zones cannot shift the date.
    const due = new Date(`${localMoment(new Date(), tenant.timezone).date}T12:00:00Z`);
    due.setUTCDate(due.getUTCDate() + data.inDays);
    const ins = await context.supabase.from("gie_follow_up_tasks").insert({ tenant_id: tenant.tenantId, prospect_id: data.prospectId, due_date: due.toISOString().slice(0, 10), note: data.note ?? null, created_by: context.userId }).select("id").single();
    if (ins.error) throw new Error(ins.error.message);
    return { id: (ins.data as { id: string }).id };
  });

export const completeFollowUp = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, followUpId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const upd = await context.supabase.from("gie_follow_up_tasks").update({ status: "done", completed_at: new Date().toISOString() }).eq("tenant_id", tenant.tenantId).eq("id", data.followUpId).eq("status", "open").select("id");
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data?.length) throw new Error("Not found: no open follow-up with that id in this workspace.");
    return { ok: true };
  });

/** Owner only: builds today's package now (without the time check). Still at most one per local date. */
export const buildPackageNow = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "owner");
    const svc = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    return runMorningPackage(svc, context.env, { id: tenant.tenantId, slug: tenant.slug, timezone: tenant.timezone }, new Date(), { force: true });
  });

export type FollowUpRow = { id: string; dueDate: string; note: string | null; businessName: string; overdue: boolean };

export const getFollowUps = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput }).parse(d))
  .handler(async ({ data, context }): Promise<{ items: FollowUpRow[]; canAct: boolean }> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "viewer");
    const today = localMoment(new Date(), tenant.timezone).date;
    const rows = await context.supabase.from("gie_follow_up_tasks").select("id, due_date, note, prospect:gie_prospects!inner(business_name)").eq("tenant_id", tenant.tenantId).eq("status", "open").order("due_date").limit(200);
    if (rows.error) throw new Error(rows.error.message);
    return {
      canAct: hasRole(tenant.role, "operator"),
      items: ((rows.data ?? []) as any[]).map((r) => ({ id: r.id, dueDate: r.due_date, note: r.note, businessName: r.prospect.business_name, overdue: r.due_date < today })),
    };
  });

/** Sends an approved draft. A separate, deliberate click from approving: it re-checks everything first. */
export const sendDraft = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, draftId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const svc = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    return sendApprovedDraft(context.env, svc, { id: tenant.tenantId, slug: tenant.slug }, data.draftId, context.userId);
  });

export type ReplyView = { id: string; prospectId: string; businessName: string; fromEmail: string; subject: string | null; snippet: string | null; kind: "reply" | "auto_reply" | "bounce"; receivedAt: string };

export const getReplies = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput }).parse(d))
  .handler(async ({ data, context }): Promise<ReplyView[]> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const r = await context.supabase.from("gie_outreach_replies").select("id, prospect_id, from_email, subject, snippet, kind, received_at, prospect:gie_prospects(business_name)").eq("tenant_id", tenant.tenantId).eq("status", "new").order("received_at", { ascending: false }).limit(20);
    if (r.error) throw new Error(r.error.message);
    return ((r.data ?? []) as any[]).map((x) => ({ id: x.id, prospectId: x.prospect_id, businessName: x.prospect?.business_name ?? "Unknown", fromEmail: x.from_email, subject: x.subject, snippet: x.snippet, kind: x.kind, receivedAt: x.received_at }));
  });

export const markReplyHandled = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput, replyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "operator");
    const upd = await context.supabase.from("gie_outreach_replies").update({ status: "handled" }).eq("tenant_id", tenant.tenantId).eq("id", data.replyId).select("id");
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data?.length) throw new Error("Not found: that reply does not exist in this workspace.");
    return { ok: true };
  });
