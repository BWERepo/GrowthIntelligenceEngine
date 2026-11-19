// Facebook-only prospects (owner's decision, 2026-11-19): a business whose
// only web presence is a Facebook page. Facebook itself is never fetched or
// scraped (plan section 7.1). The only material used is what the search
// provider returned for the result (title and snippet), plus one more search
// for the business's own website. Pure helpers, unit-tested.
import { hostOf } from "./url";
import type { SearchResult } from "@/lib/providers/search/types";

const FACEBOOK_HOSTS = ["facebook.com", "m.facebook.com", "web.facebook.com", "business.facebook.com"];

export function isFacebookHost(host: string | null): boolean {
  return !!host && FACEBOOK_HOSTS.includes(host);
}

// First path segments that are never a business's own page.
const NOT_A_PAGE = new Set([
  "groups", "events", "watch", "marketplace", "share", "sharer", "sharer.php", "photo", "photo.php", "photos", "story.php",
  "permalink.php", "posts", "people", "profile.php", "login", "login.php", "help", "policies", "privacy", "hashtag", "reel",
  "reels", "videos", "gaming", "jobs", "fundraisers", "ads", "business", "public", "search", "stories", "notes", "media", "l.php", "dialog",
]);

/**
 * The canonical "https://facebook.com/<page>" for a result that is a business's
 * Facebook page, or null for anything else (groups, posts, events, people,
 * login pages). Only the page's own root counts, so a post on a page is not taken.
 */
export function facebookPageUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!isFacebookHost(hostOf(raw))) return null;
  const segs = u.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  // facebook.com/pages/<Name>/<id> (older page URLs) and facebook.com/p/<Name-id>.
  if (segs[0] === "pages" && segs.length >= 2 && segs.length <= 3) return `https://facebook.com/${segs.map(encodeURIComponent).join("/")}`;
  if (segs[0] === "p" && segs.length === 2) return `https://facebook.com/p/${encodeURIComponent(segs[1]!)}`;
  if (segs.length !== 1) return null;
  const slug = segs[0]!;
  if (NOT_A_PAGE.has(slug.toLowerCase()) || !/^[A-Za-z0-9.\-_]{3,100}$/.test(slug)) return null;
  return `https://facebook.com/${slug}`;
}

/** The search result as text the classifier can quote from: title, then snippet. Null when there is no snippet. */
export function snippetText(r: { title: string | null; snippet: string | null }): string | null {
  if (!r.snippet) return null;
  return [r.title, r.snippet].filter(Boolean).join("\n");
}

const STOP = new Set(["the", "and", "of", "llc", "inc", "co", "company", "corp", "ltd", "pllc", "pc", "dba", "a", "an", "at", "in", "on", "tn", "services", "service"]);

/** Words of a business name that identify it: lowercase, letters and digits only, no legal suffixes. */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));
}

/**
 * True when a website host plausibly belongs to the named business: the host's
 * name (before the TLD, hyphens ignored) contains two consecutive words of the
 * name run together, or the single word of a one-word name (5+ characters).
 * Deliberately loose: a false "has a website" only means the lead is not
 * called Facebook-only, while a false "no website" would be a wrong claim.
 */
export function hostMatchesName(host: string, name: string): boolean {
  const label = host.split(".").slice(0, -1).join("").replace(/-/g, "");
  if (!label) return false;
  const t = nameTokens(name);
  if (t.length === 0) return false;
  if (t.length === 1) return t[0]!.length >= 5 && label.includes(t[0]!);
  for (let i = 0; i + 1 < t.length; i++) if (label.includes(t[i]! + t[i + 1]!)) return true;
  return false;
}

/**
 * Looks through the results of a "<name> <location>" search for the business's
 * own website. Returns the first result whose host matches the name, or null.
 * `excluded` filters directories and social sites (they are not own websites).
 */
export function findOwnWebsite(results: SearchResult[], name: string, excluded: (host: string) => boolean): string | null {
  for (const r of results) {
    const host = hostOf(r.url);
    if (!host || isFacebookHost(host) || excluded(host)) continue;
    if (hostMatchesName(host, name)) return r.url;
  }
  return null;
}
