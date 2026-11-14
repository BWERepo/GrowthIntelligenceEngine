import { describe, expect, it } from "vitest";
import { validateDraft, type DraftInput } from "@/lib/actions/draft-validator";

const U = "{{unsubscribe_link}}";
const A = "{{mailing_address}}";
const good: DraftInput = {
  subject: "A quick idea for Smith Family Dental's website",
  body: `Hello,\n\nI noticed Smith Family Dental's site takes a while to load on phones (PageSpeed measured it at 42 out of 100 for performance). I help small practices in East Tennessee get a faster, clearer website. If it would be useful, I can send a few specific ideas, no strings attached.\n\nAlvin, Business Web Express\n${U}\n${A}`,
  followUpBody: "Following up on my note last week about Smith Family Dental's site. Happy to share the ideas whenever it suits you.",
  signalType: "prospecting",
  prospect: { businessName: "Smith Family Dental", websiteHost: "smithfamilydental.com" },
  unsubscribeMarker: U,
  mailingAddressMarker: A,
};
const rules = (d: Partial<DraftInput>) => validateDraft({ ...good, ...d }).errors.map((e) => e.rule);

describe("draft validator", () => {
  it("accepts a plain, specific, compliant draft", () => {
    const v = validateDraft(good);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });
  it("requires the unsubscribe line and the mailing address", () => {
    expect(rules({ body: good.body.replace(U, "") })).toContain("unsubscribe");
    expect(rules({ body: good.body.replace(A, "") })).toContain("mailing-address");
  });
  it("rejects prohibited claims", () => {
    expect(rules({ body: good.body + " We guarantee you'll rank first on Google." })).toContain("no-guarantees");
    expect(rules({ body: good.body + " We'll get you to #1 on Google." })).toContain("no-ranking-promise");
    expect(rules({ body: good.body + " Our 40 clients agree." })).toContain("no-client-counts");
    expect(rules({ body: good.body + " Read our five-star testimonials." })).toContain("no-testimonials");
    expect(rules({ body: good.body + " Our AI-powered process is fast." })).toContain("no-ai-lead");
    expect(rules({ body: good.body + " Act now, limited time!" })).toContain("no-pressure");
    expect(rules({ body: good.body + " We're a local company." })).toContain("no-local-claim");
  });
  it("blocks implying a request when the signal was prospecting, but allows it for buying intent", () => {
    const implied = good.body + " I saw you were looking for a web designer.";
    expect(rules({ body: implied })).toContain("implied-request");
    expect(rules({ body: implied, signalType: "buying_intent" })).not.toContain("implied-request");
  });
  it("rejects fake replies, empty subjects and very short messages", () => {
    expect(rules({ subject: "Re: your website" })).toContain("fake-reply");
    expect(rules({ subject: "  " })).toContain("subject");
    expect(rules({ body: `Hi ${U} ${A}` })).toContain("too-short");
  });
  it("warns, without blocking, about generic phrasing, unknown links and unverified numbers", () => {
    const v = validateDraft({ ...good, body: good.body + " I hope this email finds you well. See https://example.org/x and smithfamilydental.com loads in 6 seconds to load or 80%." });
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.rule)).toEqual(expect.arrayContaining(["generic-phrasing", "unknown-link", "unverified-number"]));
  });
  it("checks the follow-up text too", () => {
    expect(rules({ followUpBody: "We guarantee a #1 ranking for Smith Family Dental, act now." })).toEqual(expect.arrayContaining(["no-guarantees", "no-pressure"]));
  });
});
