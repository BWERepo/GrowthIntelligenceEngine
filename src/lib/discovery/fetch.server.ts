// Fetches a public web page politely: robots.txt is read and obeyed first,
// one request at a time per host with a pause between them, a short timeout,
// a size cap, HTML/text only, and redirects followed by hand so every hop is
// checked against the same rules. Identifies itself honestly.
import { findContactChannels, htmlTitle, htmlToText, pageLinks, type ContactChannels } from "./html";
import { isAllowed, parseRobots, robotsUnavailable, USER_AGENT_TOKEN, type RobotsRules } from "./robots";
import { isPublicWebUrlString } from "./url";

export const USER_AGENT = `Mozilla/5.0 (compatible; ${USER_AGENT_TOKEN}/1.0; +https://businesswebexpress.com/)`;
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;
const PER_HOST_GAP_MS = 2_000;

export type FetchedPage =
  | {
      ok: true;
      finalUrl: string;
      status: number;
      title: string | null;
      text: string;
      contact: ContactChannels;
      links: string[];
      contentHash: string;
    }
  | { ok: false; finalUrl: string; status: number | null; reason: "robots" | "not_public" | "http_error" | "not_html" | "too_large" | "network" };

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return null;
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

/** One fetcher per run: it remembers robots.txt per host and spaces requests to the same host. */
export function createPoliteFetcher(fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  const robotsCache = new Map<string, RobotsRules>();
  const lastHit = new Map<string, number>();

  async function wait(host: string) {
    const last = lastHit.get(host);
    if (last !== undefined) {
      const gap = Date.now() - last;
      if (gap < PER_HOST_GAP_MS) await sleep(PER_HOST_GAP_MS - gap);
    }
    lastHit.set(host, Date.now());
  }

  async function timed(url: string, init: RequestInit = {}): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetchImpl(url, { ...init, redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) } });
    } finally {
      clearTimeout(t);
    }
  }

  async function robotsFor(u: URL): Promise<RobotsRules> {
    const key = `${u.protocol}//${u.host}`;
    const cached = robotsCache.get(key);
    if (cached) return cached;
    let rules: RobotsRules;
    try {
      await wait(u.host);
      const res = await timed(`${key}/robots.txt`, { headers: { Accept: "text/plain" } });
      if (res.status >= 300 && res.status < 400) {
        rules = { groups: [] }; // redirected robots.txt: treated as unavailable (4xx-like) rather than followed off-site
      } else if (!res.ok) {
        rules = robotsUnavailable(res.status);
      } else {
        rules = parseRobots(((await readCapped(res)) ?? "").slice(0, 500_000));
      }
    } catch {
      rules = robotsUnavailable(null);
    }
    robotsCache.set(key, rules);
    return rules;
  }

  /** Fetches `startUrl`, obeying robots.txt for every hop. */
  async function fetchPage(startUrl: string): Promise<FetchedPage> {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isPublicWebUrlString(url)) return { ok: false, finalUrl: url, status: null, reason: "not_public" };
      const u = new URL(url);
      if (!isAllowed(await robotsFor(u), `${u.pathname}${u.search}`)) return { ok: false, finalUrl: url, status: null, reason: "robots" };
      let res: Response;
      try {
        await wait(u.host);
        res = await timed(url, { headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.8" } });
      } catch {
        return { ok: false, finalUrl: url, status: null, reason: "network" };
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, finalUrl: url, status: res.status, reason: "http_error" };
        url = new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) return { ok: false, finalUrl: url, status: res.status, reason: "http_error" };
      const type = res.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) return { ok: false, finalUrl: url, status: res.status, reason: "not_html" };
      const body = await readCapped(res);
      if (body === null) return { ok: false, finalUrl: url, status: res.status, reason: "too_large" };
      const isHtml = !/text\/plain/i.test(type);
      const text = isHtml ? htmlToText(body) : body;
      return {
        ok: true,
        finalUrl: url,
        status: res.status,
        title: isHtml ? htmlTitle(body) : null,
        text,
        contact: isHtml ? findContactChannels(body, url) : { emails: [], phones: [], hasContactForm: false, contactPageUrl: null },
        links: isHtml ? pageLinks(body, url) : [],
        contentHash: await sha256Hex(text),
      };
    }
    return { ok: false, finalUrl: url, status: null, reason: "http_error" };
  }

  return { fetchPage };
}
