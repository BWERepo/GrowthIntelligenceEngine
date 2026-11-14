import { beforeEach, describe, expect, it, vi } from "vitest";
import { mutableDb } from "./mutable-db";

const suppression = vi.hoisted(() => ({ result: { clear: true } as any }));
vi.mock("@/lib/actions/suppression.server", () => ({ checkSuppression: async () => suppression.result }));
const biz = vi.hoisted(() => ({ row: { mailing_address: "PO Box 1", mailing_city: "Knoxville", mailing_state: "TN", mailing_zip: "37901" } as any }));
vi.mock("@/lib/bwe-source.server", () => ({
  bweReader: () => ({ from: () => ({ select: () => ({ limit: () => ({ maybeSingle: async () => ({ data: biz.row, error: null }) }) }) }) }),
}));

import { sendApprovedDraft } from "@/lib/pipeline/send.server";

const env: any = { GIE_DB_SCHEMA: "gie_staging", LEAD_EMAIL_SMTP_USER: "me@biz.net", LEAD_EMAIL_SMTP_PASSWORD: "password-1234", UNSUBSCRIBE_SECRET: "0123456789abcdef-secret", UNSUBSCRIBE_BASE_URL: "https://businesswebexpress.com", GIE_DAILY_SEND_CAP: 2 };
const tenant = { id: "t1", slug: "bwe" };
const now = new Date("2026-11-16T15:00:00Z");
const BODY = "Hello Pat Owner, I noticed your shop's website and wanted to say hello. We build simple sites.\n\n{{unsubscribe_link}}\n{{mailing_address}}";

function world(over: { draft?: Record<string, unknown>; prospect?: Record<string, unknown>; extraSent?: number } = {}) {
  return mutableDb({
    gie_outreach_drafts: [
      { id: "d1", tenant_id: "t1", prospect_id: "p1", status: "approved", subject: "Hello", body: BODY, follow_up_body: null, sent_at: null, ...over.draft },
      ...Array.from({ length: over.extraSent ?? 0 }, (_, i) => ({ id: `s${i}`, tenant_id: "t1", prospect_id: `x${i}`, status: "sent", sent_at: "2026-11-16T10:00:00Z" })),
    ],
    gie_prospects: [{ id: "p1", tenant_id: "t1", business_name: "Pat Owner Shop", website_url: null, contact_email: "Pat@Shop.com", do_not_contact: false, opportunity_id: "o1", ...over.prospect }],
    gie_opportunities: [{ id: "o1", tenant_id: "t1", signal_type: "prospecting" }],
    gie_audit_events: [],
    gie_follow_up_tasks: [],
  });
}
const okSend = () => vi.fn(async () => ({ messageId: "<abc@biz.net>" }));

beforeEach(() => {
  suppression.result = { clear: true };
  biz.row = { mailing_address: "PO Box 1", mailing_city: "Knoxville", mailing_state: "TN", mailing_zip: "37901" };
});

describe("sending an approved draft", () => {
  it("sends once, to the lowercased address, with the footer filled, and records it", async () => {
    const db = world();
    const send = okSend();
    const r = await sendApprovedDraft(env, db, tenant, "d1", "u1", now, send as any);
    expect(r).toEqual({ ok: true, messageId: "<abc@biz.net>", to: "pat@shop.com" });
    const mail = (send.mock.calls[0] as any[])[1];
    expect(mail.to).toBe("pat@shop.com");
    expect(mail.bcc).toBe("me+log-staging@biz.net");
    expect(mail.text).toContain("PO Box 1, Knoxville TN 37901");
    expect(mail.text).not.toContain("{{");
    expect(db.tables.gie_outreach_drafts[0]).toMatchObject({ status: "sent", sent_message_id: "<abc@biz.net>", sent_from: "me@biz.net" });
    expect(db.tables.gie_follow_up_tasks).toHaveLength(1);
    expect(db.tables.gie_audit_events[0]).toMatchObject({ action: "draft.send" });
    // A second press never sends again.
    expect(await sendApprovedDraft(env, db, tenant, "d1", "u1", now, send as any)).toEqual({ ok: false, reason: "This draft was already sent." });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not send a draft nobody approved", async () => {
    const send = okSend();
    const r = await sendApprovedDraft(env, world({ draft: { status: "draft" } }), tenant, "d1", "u1", now, send as any);
    expect(r.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["do-not-contact", { prospect: { do_not_contact: true } }],
    ["no email", { prospect: { contact_email: null } }],
    ["a validator error", { draft: { body: "too short {{unsubscribe_link}} {{mailing_address}}" } }],
  ])("refuses for %s", async (_n, over) => {
    const send = okSend();
    const r = await sendApprovedDraft(env, world(over as any), tenant, "d1", "u1", now, send as any);
    expect(r.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an address on BWE's lists and marks the prospect do-not-contact", async () => {
    suppression.result = { clear: false, listed: true, reason: "pat@shop.com is on BWE's suppression list." };
    const db = world();
    const send = okSend();
    expect((await sendApprovedDraft(env, db, tenant, "d1", "u1", now, send as any)).ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(db.tables.gie_prospects[0].do_not_contact).toBe(true);
  });

  it("refuses when the lists cannot be checked", async () => {
    suppression.result = { clear: false, listed: false, reason: "could not be read" };
    const send = okSend();
    expect((await sendApprovedDraft(env, world(), tenant, "d1", "u1", now, send as any)).ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("stops at the daily cap", async () => {
    const send = okSend();
    const r = await sendApprovedDraft(env, world({ extraSent: 2 }), tenant, "d1", "u1", now, send as any);
    expect(r).toMatchObject({ ok: false });
    expect((r as any).reason).toMatch(/daily limit/);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses without the mail login, the unsubscribe secret, or BWE's mailing address", async () => {
    const send = okSend();
    expect((await sendApprovedDraft({ ...env, LEAD_EMAIL_SMTP_PASSWORD: undefined }, world(), tenant, "d1", "u1", now, send as any)).ok).toBe(false);
    expect((await sendApprovedDraft({ ...env, UNSUBSCRIBE_SECRET: undefined }, world(), tenant, "d1", "u1", now, send as any)).ok).toBe(false);
    biz.row = { mailing_address: "" };
    expect((await sendApprovedDraft(env, world(), tenant, "d1", "u1", now, send as any)).ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("puts the draft back to approved, with the reason, when the mail server fails", async () => {
    const db = world();
    const r = await sendApprovedDraft(env, db, tenant, "d1", "u1", now, (async () => { throw new Error("SMTP RCPT TO failed (550)"); }) as any);
    expect(r).toMatchObject({ ok: false });
    expect(db.tables.gie_outreach_drafts[0]).toMatchObject({ status: "approved", sent_at: null, send_error: "SMTP RCPT TO failed (550)" });
    expect(db.tables.gie_follow_up_tasks).toHaveLength(0);
  });
});
