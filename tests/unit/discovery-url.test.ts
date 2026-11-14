import { describe, expect, it } from "vitest";
import { dedupeKey, isPublicWebUrlString, normalizeUrl } from "@/lib/discovery/url";
import { candidatesFromResults, planQueries } from "@/lib/discovery/queries";

describe("URL normalization", () => {
  it("makes the same page compare equal", () => {
    const a = normalizeUrl("http://WWW.Example.com/About/?utm_source=x&b=2&a=1#team");
    const b = normalizeUrl("https://example.com/About?a=1&b=2");
    expect(a).toBe("https://example.com/About?a=1&b=2");
    expect(a).toBe(b);
  });
  it("keeps the root as the bare host", () => {
    expect(normalizeUrl("https://www.acme-hvac.com/")).toBe("https://acme-hvac.com");
  });
  it("refuses URLs the fetcher must never touch", () => {
    for (const bad of [
      "ftp://example.com/x",
      "http://localhost/admin",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://[::1]/",
      "http://intranet/",
      "http://printer.local/",
      "https://user:pass@example.com/",
      "https://example.com:8443/",
      "javascript:alert(1)",
    ]) {
      expect(isPublicWebUrlString(bad), bad).toBe(false);
      expect(normalizeUrl(bad), bad).toBeNull();
    }
  });
});

describe("duplicate keys", () => {
  it("uses the verified website host, so two pages of one business are one opportunity", () => {
    expect(dedupeKey("https://www.smithdental.com/", "https://news.example.com/a")).toBe("site:smithdental.com");
    expect(dedupeKey("http://smithdental.com/contact", "https://other.example.org/b")).toBe("site:smithdental.com");
  });
  it("falls back to the page URL when no website was verified", () => {
    expect(dedupeKey(null, "https://www.example.org/rfp/123?utm_campaign=z")).toBe("page:example.org/rfp/123");
  });
});

describe("query planning", () => {
  it("expands {location}, alternates signal types, removes duplicates and respects the daily limit", () => {
    const plan = planQueries({
      buyingIntentQueries: ["need a website {location}", "need a website {location}"],
      prospectingQueries: ["dentist {location}"],
      locations: ["Knoxville, TN", "Chattanooga, TN"],
      dailySearchLimit: 3,
    });
    expect(plan).toEqual([
      { query: "need a website Knoxville, TN", signalType: "buying_intent" },
      { query: "dentist Knoxville, TN", signalType: "prospecting" },
      { query: "need a website Chattanooga, TN", signalType: "buying_intent" },
    ]);
  });
});

describe("search results to candidates", () => {
  it("drops social and review sites, files, private URLs and duplicates", () => {
    const r = (url: string) => ({ url, title: "t", snippet: null, publishedAt: null });
    const out = candidatesFromResults([
      r("https://www.facebook.com/somebiz"),
      r("https://m.yelp.com/biz/x"),
      r("https://smithdental.com/"),
      r("https://www.smithdental.com/?utm_source=brave"),
      r("https://example-chamber.org/rfp.pdf"),
      r("http://192.168.1.1/"),
      r("https://knoxhvac.com/about"),
    ]);
    expect(out.map((c) => c.normalizedUrl)).toEqual(["https://smithdental.com", "https://knoxhvac.com/about"]);
  });
});
