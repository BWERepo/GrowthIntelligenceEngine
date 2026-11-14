// URL handling for discovery: normalizing, duplicate keys, and refusing URLs
// the fetcher must never touch (private networks, odd ports, credentials).
// Pure, so it is unit-tested without a network.

const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_src|_ga|_gl|yclid)$/i;

/**
 * A stable form of a URL for comparing and storing: lowercase host without
 * "www.", no fragment, no tracking parameters, sorted query, no trailing slash
 * (except the root), default ports dropped. Returns null for anything that is
 * not a public http(s) URL.
 */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!isPublicWebUrl(u)) return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  u.hostname = stripWww(u.hostname.toLowerCase().replace(/\.$/, ""));
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  u.pathname = path || "/";
  // https and http versions of a page are the same page for duplicate purposes.
  const out = `${u.host}${u.pathname === "/" ? "" : u.pathname}${u.search}`;
  return `https://${out}`;
}

export function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

export function hostOf(raw: string): string | null {
  try {
    return stripWww(new URL(raw).hostname.toLowerCase().replace(/\.$/, ""));
  } catch {
    return null;
  }
}

/**
 * Duplicate key for an opportunity: the business's website host when it was
 * verified (one opportunity per business), otherwise the normalized page URL.
 */
export function dedupeKey(websiteUrl: string | null, sourceUrl: string): string | null {
  if (websiteUrl) {
    const host = hostOf(websiteUrl);
    if (host) return `site:${host}`;
  }
  const n = normalizeUrl(sourceUrl);
  return n ? `page:${n.replace(/^https:\/\//, "")}` : null;
}

/** http(s) only, standard ports, a public-looking DNS name: no IP literals, localhost or internal names. */
export function isPublicWebUrl(u: URL): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".")) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith("[") || host.includes(":")) return false; // IP literals
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host)) return false;
  if (!/^[a-z0-9.-]+$/.test(host)) return false; // punycode only; no raw unicode tricks
  return true;
}

export function isPublicWebUrlString(raw: string): boolean {
  try {
    return isPublicWebUrl(new URL(raw));
  } catch {
    return false;
  }
}
