// Broken-link evidence for outreach. Only a link that answers 404 or 410 is
// counted as broken: timeouts, 403s, 5xx and robots-blocked pages are
// "unknown" and never reported. Pure helpers; the fetching is in the pipeline.
import { hostOf } from "./url";

export const MAX_LINKS_CHECKED = 10;
const SKIP_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|svg|webp|mp4|css|js|ico)$/i;

/** Same-site pages linked from the homepage, without duplicates, fragments or the page itself. */
export function pickLinksToCheck(links: string[], siteUrl: string, max = MAX_LINKS_CHECKED): string[] {
  const host = hostOf(siteUrl)?.replace(/^www\./, "");
  if (!host) return [];
  const self = siteUrl.replace("//www.", "//").replace(/\/+$/, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    let u: URL;
    try { u = new URL(l); } catch { continue; }
    if ((hostOf(l) ?? "").replace(/^www\./, "") !== host) continue;
    if (SKIP_EXT.test(u.pathname)) continue;
    u.hash = "";
    const key = u.toString().replace("//www.", "//").replace(/\/+$/, "");
    if (key === self || seen.has(key)) continue;
    seen.add(key);
    out.push(u.toString());
    if (out.length >= max) break;
  }
  return out;
}

export type LinkResult = { url: string; status: number | null };
export type LinkCheckMetrics = { checked: number; broken: Array<{ url: string; status: number }> };

export function summarizeLinks(results: LinkResult[]): LinkCheckMetrics {
  return {
    checked: results.length,
    broken: results.filter((r): r is { url: string; status: number } => r.status === 404 || r.status === 410),
  };
}

/** One plain sentence for a draft prompt or the screen; null when nothing was found broken. */
export function brokenLinkSentence(m: LinkCheckMetrics | null): string | null {
  if (!m || m.broken.length === 0) return null;
  const n = m.broken.length;
  return `${n} of ${m.checked} pages linked from their homepage ${n === 1 ? "returns" : "return"} "page not found": ${m.broken.map((b) => b.url).slice(0, 3).join(", ")}`;
}
