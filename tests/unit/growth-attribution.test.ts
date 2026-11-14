import { describe, expect, it } from "vitest";
import { attributeTo, makeLinker, type ProspectRef } from "@/lib/growth/attribution";

const p = (id: string, extra: Partial<ProspectRef> = {}): ProspectRef => ({ id, contactEmail: null, bweLeadId: null, firstContactAt: null, ...extra });

describe("attribution", () => {
  it("is high only with a stored id link", () => {
    const l = makeLinker([p("p1", { bweLeadId: "L1" })], [{ id: "L1", email: "x@a.com", createdAt: "2026-11-10T00:00:00Z" }]);
    expect(l.forLead({ id: "L1", email: "x@a.com", createdAt: "2026-11-10T00:00:00Z" })!.confidence).toBe("high");
  });
  it("is medium for an email match and unknown for no match", () => {
    const l = makeLinker([p("p1", { contactEmail: "Owner@Shop.com" })], []);
    expect(l.forLead({ id: "L2", email: " owner@shop.com ", createdAt: "2026-11-10T00:00:00Z" })!.confidence).toBe("medium");
    expect(attributeTo(l.forLead({ id: "L3", email: "other@shop.com", createdAt: "2026-11-10T00:00:00Z" }))).toMatchObject({ attribution: "unknown", confidence: "none", prospectId: null });
  });
  it("links to nothing when an email matches two prospects", () => {
    const l = makeLinker([p("p1", { contactEmail: "a@b.com" }), p("p2", { contactEmail: "a@b.com" })], []);
    expect(l.forLead({ id: "L", email: "a@b.com", createdAt: "2026-11-10T00:00:00Z" })).toBeNull();
  });
  it("is first touch when we emailed before they appeared, assisted otherwise", () => {
    const first = makeLinker([p("p1", { bweLeadId: "L1", firstContactAt: "2026-11-01T00:00:00Z" })], []);
    expect(attributeTo(first.forLead({ id: "L1", email: null, createdAt: "2026-11-10T00:00:00Z" }))).toMatchObject({ attribution: "first_touch", confidence: "high" });
    const late = makeLinker([p("p1", { bweLeadId: "L1", firstContactAt: "2026-11-20T00:00:00Z" })], []);
    expect(attributeTo(late.forLead({ id: "L1", email: null, createdAt: "2026-11-10T00:00:00Z" })).attribution).toBe("assisted");
    const never = makeLinker([p("p1", { bweLeadId: "L1" })], []);
    expect(attributeTo(never.forLead({ id: "L1", email: null, createdAt: "2026-11-10T00:00:00Z" })).attribution).toBe("assisted");
  });
  it("links a customer by email through a linked lead, as medium confidence", () => {
    const l = makeLinker([p("p1", { bweLeadId: "L1", firstContactAt: "2026-11-01T00:00:00Z" })], [{ id: "L1", email: "c@x.com", createdAt: "2026-11-05T00:00:00Z" }]);
    expect(attributeTo(l.forOwnerEmail("C@x.com", "2026-11-15T00:00:00Z"))).toMatchObject({ prospectId: "p1", attribution: "first_touch", confidence: "medium" });
    expect(l.forOwnerEmail(null, "2026-11-15T00:00:00Z")).toBeNull();
  });
});
