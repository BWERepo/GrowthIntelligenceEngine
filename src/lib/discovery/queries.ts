// Turns a campaign into the day's search queries, and search results into
// queue candidates. Pure.
import { hostOf, normalizeUrl } from "./url";
import type { SearchResult } from "@/lib/providers/search/types";
import { facebookPageUrl, isFacebookHost } from "./facebook";

export type CampaignQueries = {
  buyingIntentQueries: string[];
  prospectingQueries: string[];
  locations: string[];
  dailySearchLimit: number;
};

export type PlannedQuery = { query: string; signalType: "buying_intent" | "prospecting" };

/**
 * "{location}" is replaced by each campaign location in turn; a query without
 * it runs once. Buying-intent and prospecting queries alternate so a low limit
 * still covers both, and duplicates are dropped. At most `dailySearchLimit`.
 */
export function planQueries(c: CampaignQueries): PlannedQuery[] {
  const expand = (q: string): string[] =>
    q.includes("{location}") ? (c.locations.length ? c.locations.map((l) => q.replaceAll("{location}", l)) : [q.replaceAll("{location}", "").trim()]) : [q];
  const intent = c.buyingIntentQueries.flatMap(expand).map((query) => ({ query: query.trim(), signalType: "buying_intent" as const }));
  const prospect = c.prospectingQueries.flatMap(expand).map((query) => ({ query: query.trim(), signalType: "prospecting" as const }));
  const out: PlannedQuery[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(intent.length, prospect.length); i++) {
    for (const q of [intent[i], prospect[i]]) {
      if (!q || !q.query) continue;
      const key = `${q.signalType}:${q.query.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(q);
    }
  }
  return out.slice(0, Math.max(0, c.dailySearchLimit));
}

// Sites that are never fetched: social networks and community or review sites
// whose terms forbid automated collection, and search engines themselves.
// (Plan section 7.1: no Facebook/LinkedIn scraping, no private groups.)
const EXCLUDED_HOSTS = [
  "facebook.com", "fb.com", "instagram.com", "linkedin.com", "x.com", "twitter.com", "tiktok.com", "threads.net",
  "reddit.com", "nextdoor.com", "pinterest.com", "youtube.com", "quora.com",
  "yelp.com", "google.com", "bing.com", "duckduckgo.com", "search.brave.com", "maps.apple.com",
  "craigslist.org", "upwork.com", "fiverr.com", "thumbtack.com", "angi.com", "homeadvisor.com",
];

export function excludedHost(host: string): boolean {
  return EXCLUDED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export type CandidateDraft = {
  url: string;
  normalizedUrl: string;
  title: string | null;
  snippet: string | null;
  publishedAt: Date | null;
};

/**
 * Normalizes, drops excluded and non-public URLs, and removes duplicates within one result list.
 * With `facebookPages` (prospecting searches), a result that is a business's
 * Facebook page is kept as a Facebook-only candidate: it is never fetched,
 * only its search title and snippet are used (see discovery/facebook.ts).
 */
export function candidatesFromResults(results: SearchResult[], opts: { facebookPages?: boolean } = {}): CandidateDraft[] {
  const out: CandidateDraft[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (opts.facebookPages && isFacebookHost(hostOf(r.url))) {
      const page = facebookPageUrl(r.url);
      if (!page || !r.snippet || seen.has(page)) continue;
      seen.add(page);
      out.push({ url: page, normalizedUrl: page, title: r.title, snippet: r.snippet, publishedAt: null });
      continue;
    }
    const normalizedUrl = normalizeUrl(r.url);
    if (!normalizedUrl) continue;
    const host = hostOf(normalizedUrl);
    if (!host || excludedHost(host)) continue;
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|mp4)$/i.test(new URL(normalizedUrl).pathname)) continue;
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    out.push({ url: r.url, normalizedUrl, title: r.title, snippet: r.snippet, publishedAt: r.publishedAt });
  }
  return out;
}

/**
 * Searches for businesses that are unhappy with their current web provider or
 * are looking to switch. Offered as one-click additions to a campaign's
 * buying-intent list; the owner can edit or remove them. Competitor names are
 * only used in the owner's own text, never invented.
 */
export const SWITCHING_QUERY_TEMPLATES: readonly string[] = [
  "unhappy with my web designer {location}",
  "need a new web designer {location}",
  "looking for a new website company {location}",
  "switching web design agencies {location}",
  "my website developer disappeared {location}",
];

/** Templates for each named competitor, e.g. "alternative to Wix {location}". Names are trimmed and de-duplicated. */
export function competitorQueries(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const n = raw.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(`alternative to ${n} {location}`, `leaving ${n} for a new website {location}`);
  }
  return out;
}

/** Adds queries to an existing list without repeating one already there (case-insensitive). */
export function addQueries(existing: string[], additions: readonly string[]): string[] {
  const have = new Set(existing.map((q) => q.trim().toLowerCase()));
  const out = [...existing];
  for (const a of additions) if (!have.has(a.trim().toLowerCase())) { have.add(a.trim().toLowerCase()); out.push(a); }
  return out;
}
