import { describe, expect, it } from "vitest";
import { composeOutreach, formatMailingAddress } from "@/lib/actions/outreach-message";
import { unsubscribeUrl } from "@/lib/actions/unsubscribe-link.server";
import { buildMessage, logBccAddress } from "@/lib/providers/mail/smtp.server";
import { parseMessage } from "@/lib/providers/mail/imap.server";
import { classifyReply, matchReplies, snippetOf } from "@/lib/pipeline/replies.server";

const body = "Hello there, this is a short note that is long enough to be a real message for the test.\n\nStop: {{unsubscribe_link}}\n{{mailing_address}}";

describe("composing an approved draft", () => {
  it("fills the unsubscribe link and mailing address and adds List-Unsubscribe", () => {
    const c = composeOutreach({ subject: " Hi ", body, unsubscribeUrl: "https://x.test/unsubscribe?t=abc", mailingAddress: "PO Box 1, Knoxville TN 37901" });
    expect(c.subject).toBe("Hi");
    expect(c.text).toContain("https://x.test/unsubscribe?t=abc");
    expect(c.text).toContain("PO Box 1, Knoxville TN 37901");
    expect(c.text).not.toContain("{{");
    expect(c.headers["List-Unsubscribe"]).toBe("<https://x.test/unsubscribe?t=abc>");
  });
  it("refuses a draft missing its footer, an empty address, or a leftover placeholder", () => {
    expect(() => composeOutreach({ subject: "s", body: "no markers here", unsubscribeUrl: "u", mailingAddress: "a" })).toThrow(/unsubscribe/);
    expect(() => composeOutreach({ subject: "s", body, unsubscribeUrl: "u", mailingAddress: "  " })).toThrow(/mailing address/);
    expect(() => composeOutreach({ subject: "s", body: body + " {{first_name}}", unsubscribeUrl: "u", mailingAddress: "a" })).toThrow(/placeholder/);
  });
  it("formats only the mailing address", () => {
    expect(formatMailingAddress({ mailing_address: "PO Box 1", mailing_city: "Knoxville", mailing_state: "TN", mailing_zip: "37901" })).toBe("PO Box 1, Knoxville TN 37901");
    expect(formatMailingAddress({ mailing_address: "" })).toBe("");
  });
});

describe("unsubscribe link", () => {
  it("is BWE's token format: base64url payload {e,v:1} plus an HMAC, lowercase email", async () => {
    const url = await unsubscribeUrl("0123456789abcdef-secret", "https://businesswebexpress.com/", " Owner@Example.com ");
    const t = decodeURIComponent(new URL(url).searchParams.get("t")!);
    const [payload, sig] = t.split(".");
    expect(url.startsWith("https://businesswebexpress.com/unsubscribe?t=")).toBe(true);
    expect(JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({ e: "owner@example.com", v: 1 });
    expect(sig!.length).toBeGreaterThan(30);
    expect(await unsubscribeUrl("0123456789abcdef-secret", "https://businesswebexpress.com", "owner@example.com")).toBe(url);
  });
  it("refuses without the secret", async () => {
    await expect(unsubscribeUrl(undefined, "https://x.test", "a@b.co")).rejects.toThrow(/UNSUBSCRIBE_SECRET/);
  });
});

describe("outgoing message", () => {
  it("builds plain text with the required headers", () => {
    const m = buildMessage({ fromName: 'Business "Web" Express', to: "a@b.co", subject: "Hello", text: "Body", headers: { "List-Unsubscribe": "<https://x.test>" } }, "me@biz.net", "id1");
    expect(m).toContain('From: "Business \'Web\' Express" <me@biz.net>');
    expect(m).toContain("Message-ID: <id1@biz.net>");
    expect(m).toContain("List-Unsubscribe: <https://x.test>");
    expect(m).not.toMatch(/^Bcc:/im);
    expect(Buffer.from(m.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString()).toBe("Body");
  });
  it("refuses a line break smuggled into a header", () => {
    expect(() => buildMessage({ fromName: "X", to: "a@b.co", subject: "Hi\r\nBcc: evil@x.co", text: "t" }, "me@biz.net", "i")).toThrow(/line break/);
    expect(() => buildMessage({ fromName: "X", to: "a@b.co\nBcc: e@x.co", subject: "s", text: "t" }, "me@biz.net", "i")).toThrow(/line break/);
  });
  it("encodes non-ASCII subjects", () => {
    expect(buildMessage({ fromName: "X", to: "a@b.co", subject: "Café", text: "t" }, "me@biz.net", "i")).toContain("Subject: =?UTF-8?B?");
  });
  it("uses BWE's log plus-address per environment", () => {
    expect(logBccAddress("Alvin+x@Biz.net", "gie_prod")).toBe("alvin+log@biz.net");
    expect(logBccAddress("alvin@biz.net", "gie_staging")).toBe("alvin+log-staging@biz.net");
  });
});

describe("reading replies", () => {
  const head = "From: Pat Owner <Pat@Shop.com>\r\nSubject: Re: Hello\r\nDate: Mon, 16 Nov 2026 15:00:00 +0000\r\nMessage-ID: <m1@shop.com>\r\nIn-Reply-To: <sent1@biz.net>\r\n";
  it("parses headers, including folded ones", () => {
    const m = parseMessage(head + "References: <a@x>\r\n <b@x>\r\n", "Thanks!");
    expect(m).toMatchObject({ from: "pat@shop.com", subject: "Re: Hello", messageId: "<m1@shop.com>", inReplyTo: "<sent1@biz.net>", autoSubmitted: false });
    expect(m.references).toBe("<a@x> <b@x>");
    expect(m.date?.toISOString()).toBe("2026-11-16T15:00:00.000Z");
  });
  it("tells replies, automatic replies and bounces apart", () => {
    expect(classifyReply({ from: "pat@shop.com", subject: "Re: Hello", autoSubmitted: false })).toBe("reply");
    expect(classifyReply({ from: "pat@shop.com", subject: "Automatic reply: Hello", autoSubmitted: false })).toBe("auto_reply");
    expect(classifyReply({ from: "pat@shop.com", subject: "Hi", autoSubmitted: true })).toBe("auto_reply");
    expect(classifyReply({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", autoSubmitted: false })).toBe("bounce");
  });
  it("keeps the new text, not the quote", () => {
    expect(snippetOf("Sounds good, call me.\r\nOn Mon, Nov 16, 2026 at 3:00 PM Alvin wrote:\r\n> Hello there\r\n> more")).toBe("Sounds good, call me.");
  });
  it("matches a reply to the draft sent to that address, and ignores older mail and strangers", () => {
    const sent = [{ id: "d1", prospect_id: "p1", sent_at: "2026-11-16T14:00:00Z", sent_message_id: "<sent1@biz.net>", prospect: { contact_email: "pat@shop.com" } }];
    const mk = (over: Record<string, unknown>) => ({ messageId: "<m@x>", inReplyTo: null, references: null, from: "pat@shop.com", subject: "Re: Hello", date: new Date("2026-11-16T15:00:00Z"), autoSubmitted: false, text: "ok", ...over }) as any;
    expect(matchReplies(sent, [mk({})])).toHaveLength(1);
    expect(matchReplies(sent, [mk({ date: new Date("2026-11-10T00:00:00Z") })])).toHaveLength(0);
    expect(matchReplies(sent, [mk({ from: "other@shop.com" })])).toHaveLength(0);
    const bounce = matchReplies(sent, [mk({ from: "mailer-daemon@g.com", subject: "Delivery Status Notification (Failure)", text: "Your message to pat@shop.com failed" })]);
    expect(bounce[0]!.kind).toBe("bounce");
  });
});
