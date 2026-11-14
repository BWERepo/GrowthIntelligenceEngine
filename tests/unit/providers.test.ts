import { describe, expect, it } from "vitest";
import { braveSearch, parseBraveResponse } from "@/lib/providers/search/brave.server";
import { parsePageSpeed } from "@/lib/providers/pagespeed.server";
import { estimateCostUsd } from "@/lib/providers/ai/anthropic.server";

describe("Brave Search adapter", () => {
  it("maps results and strips highlight tags", () => {
    const out = parseBraveResponse({
      web: { results: [{ url: "https://a.com/x", title: "<strong>Need</strong> a site", description: "We <strong>need</strong> help", page_age: "2026-11-01T00:00:00" }, { url: "https://b.com" }] },
    });
    expect(out[0]).toEqual({ url: "https://a.com/x", title: "Need a site", snippet: "We need help", publishedAt: new Date("2026-11-01T00:00:00") });
    expect(out[1]!.publishedAt).toBeNull();
  });
  it("treats a missing web section as no results, and a broken shape as an error", () => {
    expect(parseBraveResponse({})).toEqual([]);
    expect(() => parseBraveResponse({ web: { results: [{ title: "no url" }] } })).toThrow(/unexpected/);
  });
  it("sends the key as a header, never in the URL, and reports HTTP errors", async () => {
    let seen: { url: string; key: string | null } | null = null;
    const fake = (async (url: URL, init: RequestInit) => {
      seen = { url: url.toString(), key: new Headers(init.headers).get("X-Subscription-Token") };
      return new Response("{}", { status: 429 });
    }) as unknown as typeof fetch;
    await expect(braveSearch("secret-key-123", fake).search("dentist Knoxville", { count: 50 })).rejects.toThrow(/429/);
    expect(seen!.key).toBe("secret-key-123");
    expect(seen!.url).not.toContain("secret");
    expect(seen!.url).toContain("count=20");
  });
});

describe("PageSpeed adapter", () => {
  it("turns category scores into 0-100", () => {
    const m = parsePageSpeed({
      lighthouseResult: {
        fetchTime: "2026-11-14T10:00:00Z",
        categories: { performance: { score: 0.42 }, seo: { score: 0.9 }, accessibility: { score: null } },
        audits: { "largest-contentful-paint": { numericValue: 5123.4 } },
      },
    });
    expect(m).toMatchObject({ performance: 42, seo: 90, accessibility: null, bestPractices: null, largestContentfulPaintMs: 5123.4 });
  });
});

describe("AI cost estimates", () => {
  it("uses list prices per million tokens", () => {
    expect(estimateCostUsd("claude-opus-5-5", 4_000, 600)).toBe(0.028);
    expect(estimateCostUsd("claude-haiku-5-5", 4_000, 600)).toBe(0.0007);
  });
  it("prices an unknown model as the default, never as free", () => {
    expect(estimateCostUsd("some-new-model", 1_000_000, 0)).toBe(4);
  });
});
