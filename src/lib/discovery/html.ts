// Turns fetched HTML into the plain text the classifier reads (and evidence is
// checked against), and finds contact channels in the page's own markup.
// Regex based on purpose: no DOM in Workers, and the output is only ever text.

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", copy: "©", reg: "®",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Whitespace collapsed to single spaces; the one normal form used for text and quotes. */
export function normalizeSpace(s: string): string {
  return s.replace(/[\s ​]+/g, " ").trim();
}

export function htmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? normalizeSpace(decodeEntities(m[1]!)).slice(0, 300) || null : null;
}

export function htmlToText(html: string): string {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1>/gi, " ");
  const withBreaks = withoutHidden.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, "\n");
  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, " "));
  return text
    .split("\n")
    .map((l) => normalizeSpace(l))
    .filter(Boolean)
    .join("\n");
}

export type ContactChannels = { emails: string[]; phones: string[]; hasContactForm: boolean; contactPageUrl: string | null };

/**
 * Business contact channels published in the page itself: mailto: and tel:
 * links, and a form with an email or message field. Only what the page links
 * to is counted; nothing is guessed from free text.
 */
export function findContactChannels(html: string, pageUrl: string): ContactChannels {
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) {
    const e = decodeURIComponent(m[1]!).trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)) emails.add(e);
  }
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)/gi)) {
    const digits = decodeURIComponent(m[1]!).replace(/[^\d+]/g, "");
    if (digits.replace(/\D/g, "").length >= 10) phones.add(digits);
  }
  const forms = [...html.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  const hasContactForm = forms.some((f) => /type\s*=\s*["']email["']|name\s*=\s*["'][^"']*(email|message)[^"']*["']|<textarea/i.test(f));
  let contactPageUrl: string | null = null;
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (/contact/i.test(m[1]!) || /contact/i.test(m[2]!.replace(/<[^>]+>/g, ""))) {
      try {
        const u = new URL(m[1]!, pageUrl);
        if (u.protocol === "https:" || u.protocol === "http:") {
          contactPageUrl = u.toString();
          break;
        }
      } catch {
        /* ignore malformed links */
      }
    }
  }
  return { emails: [...emails].slice(0, 10), phones: [...phones].slice(0, 10), hasContactForm, contactPageUrl };
}

/** Absolute http(s) links in the page, for checking that a claimed website is actually linked. */
export function pageLinks(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]!), pageUrl);
      if (u.protocol === "https:" || u.protocol === "http:") out.add(u.toString());
    } catch {
      /* ignore */
    }
    if (out.size >= 2000) break;
  }
  return [...out];
}
