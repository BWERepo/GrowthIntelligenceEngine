// Brave Search API (web search). Chosen in Phase 2 over Google-scraping SERP
// APIs because it is its own index with a published API and terms; see
// docs/growth-intelligence/search-providers.md. Price recorded: $5 per 1,000
// queries (list price; Brave adds a $5 monthly credit, so real spend is lower).
import { z } from "zod";
import { ProviderError, type SearchProvider, type SearchResponse } from "./types";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const BraveResponse = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            url: z.string(),
            title: z.string().nullish(),
            description: z.string().nullish(),
            page_age: z.string().nullish(),
          }),
        )
        .default([]),
    })
    .nullish(),
});

function stripTags(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 2000) || null;
}

export function parseBraveResponse(json: unknown): SearchResponse["results"] {
  const parsed = BraveResponse.safeParse(json);
  if (!parsed.success) throw new ProviderError("brave", null, "unexpected response shape");
  return (parsed.data.web?.results ?? []).map((r) => {
    const d = r.page_age ? new Date(r.page_age) : null;
    return {
      url: r.url,
      title: stripTags(r.title)?.slice(0, 500) ?? null,
      snippet: stripTags(r.description),
      publishedAt: d && !Number.isNaN(d.getTime()) ? d : null,
    };
  });
}

export function braveSearch(apiKey: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: "brave",
    costPerQueryUsd: 0.005,
    async search(query, { count, country = "us", signal }) {
      const url = new URL(ENDPOINT);
      url.searchParams.set("q", query.slice(0, 400));
      url.searchParams.set("count", String(Math.min(20, Math.max(1, count))));
      url.searchParams.set("country", country);
      url.searchParams.set("safesearch", "moderate");
      const res = await fetchImpl(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
        signal,
      });
      if (!res.ok) throw new ProviderError("brave", res.status, `search failed with HTTP ${res.status}`);
      return { results: parseBraveResponse(await res.json()), requestId: res.headers.get("x-request-id") };
    },
  };
}
