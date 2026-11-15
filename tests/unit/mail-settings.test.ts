import { describe, expect, it } from "vitest";
import { checkMailSettings, DEFAULT_MAIL_SETTINGS, effectiveFrom } from "@/lib/mail/settings";
import { buildMessage } from "@/lib/providers/mail/smtp.server";

describe("mail settings", () => {
  it("trims, lowercases and treats blank addresses as unset", () => {
    expect(checkMailSettings({ fromName: "  BWE   Growth ", fromEmail: " Growth@BizNet.com ", replyTo: "" })).toEqual({ ok: true, value: { fromName: "BWE Growth", fromEmail: "growth@biznet.com", replyTo: null } });
  });
  it("rejects bad names and addresses", () => {
    expect(checkMailSettings({ fromName: "", fromEmail: "", replyTo: "" }).ok).toBe(false);
    expect(checkMailSettings({ fromName: "A\nB", fromEmail: "", replyTo: "" })).toMatchObject({ ok: true, value: { fromName: "A B" } });
    expect(checkMailSettings({ fromName: 'Say "hi"', fromEmail: "", replyTo: "" }).ok).toBe(false);
    expect(checkMailSettings({ fromName: "X", fromEmail: "not-an-email", replyTo: "" }).ok).toBe(false);
    expect(checkMailSettings({ fromName: "X", fromEmail: "", replyTo: "a@b" }).ok).toBe(false);
  });
  it("shows the chosen address, else the mailbox login", () => {
    expect(effectiveFrom("login@biz.net", DEFAULT_MAIL_SETTINGS)).toBe("login@biz.net");
    expect(effectiveFrom("login@biz.net", { ...DEFAULT_MAIL_SETTINGS, fromEmail: "growth@biz.net" })).toBe("growth@biz.net");
    expect(effectiveFrom(undefined, DEFAULT_MAIL_SETTINGS)).toBeNull();
  });
  it("puts the chosen From and Reply-To in the message, and refuses line breaks", () => {
    const m = buildMessage({ fromName: "BWE", fromEmail: "growth@biz.net", replyTo: "hello@biz.net", to: "a@b.co", subject: "Hi", text: "t" }, "login@biz.net", "id1");
    expect(m).toContain('From: "BWE" <growth@biz.net>');
    expect(m).toContain("Reply-To: hello@biz.net");
    expect(() => buildMessage({ fromName: "BWE", fromEmail: "g@biz.net\nBcc: x@y.co", to: "a@b.co", subject: "Hi", text: "t" }, "l@biz.net", "i")).toThrow(/line break/);
  });
});
