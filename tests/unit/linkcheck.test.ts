import { describe, expect, it } from "vitest";
import { brokenLinkSentence, pickLinksToCheck, summarizeLinks } from "@/lib/discovery/linkcheck";

describe("broken-link evidence", () => {
  it("keeps same-site pages only, once each, up to the cap", () => {
    const links = ["https://acme.com/", "https://www.acme.com/about#team", "https://acme.com/about", "https://acme.com/logo.png", "https://other.com/x", "https://acme.com/contact"];
    expect(pickLinksToCheck(links, "https://acme.com/")).toEqual(["https://www.acme.com/about", "https://acme.com/contact"]);
    expect(pickLinksToCheck(links, "https://acme.com/", 1)).toHaveLength(1);
  });
  it("counts only 404 and 410 as broken", () => {
    const m = summarizeLinks([{ url: "a", status: 404 }, { url: "b", status: 410 }, { url: "c", status: 403 }, { url: "d", status: 500 }, { url: "e", status: null }]);
    expect(m.checked).toBe(5);
    expect(m.broken.map((b) => b.url)).toEqual(["a", "b"]);
  });
  it("says nothing when nothing is broken", () => {
    expect(brokenLinkSentence(summarizeLinks([{ url: "a", status: 403 }]))).toBeNull();
    expect(brokenLinkSentence(null)).toBeNull();
    expect(brokenLinkSentence({ checked: 4, broken: [{ url: "https://acme.com/x", status: 404 }] })).toContain("1 of 4");
  });
});
