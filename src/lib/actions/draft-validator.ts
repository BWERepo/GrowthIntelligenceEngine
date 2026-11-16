// Validates an outreach draft before a person may approve it (plan section 7.4).
// Errors block approval; warnings are shown beside the draft. Pure.
//
// The rules come from BWE's verified-facts and prohibited-claims list: no
// ranking or traffic promises, no testimonials, no client counts, no pretending
// the prospect asked for help when the signal was prospecting, no unverified
// statements about the prospect's site, always an unsubscribe line and a
// postal address, never lead with AI.

export type DraftInput = {
  subject: string;
  body: string;
  followUpBody?: string | null;
  signalType: "buying_intent" | "prospecting";
  /** Facts known about the prospect; the draft may only name these. */
  prospect: { businessName: string; websiteHost: string | null };
  unsubscribeMarker: string; // text the sender inserts, e.g. "{{unsubscribe_link}}"
  mailingAddressMarker: string; // e.g. "{{mailing_address}}"
};

export type DraftFinding = { rule: string; message: string };
export type DraftValidation = { ok: boolean; errors: DraftFinding[]; warnings: DraftFinding[] };

const PROHIBITED: Array<[RegExp, string, string]> = [
  [/\b(guarantee[sd]?|guaranteed)\b[^.]{0,60}\b(rank|ranking|first page|#1|number one|traffic|leads|customers|sales)\b/i, "no-guarantees", "Do not guarantee rankings, traffic or sales."],
  [/\brank(ing)?s?\s+(on|in)\s+(the\s+)?(first|top)\s+page\b|#1\s+(on|in)\s+google|\btop\s+of\s+google\b|\bfirst\s+page\s+of\s+google\b/i, "no-ranking-promise", "Do not promise search rankings."],
  [/\b(our|my)\s+(\d+|many|dozens of|hundreds of)\s+(happy\s+)?(clients|customers)\b/i, "no-client-counts", "Do not cite client counts."],
  [/\b(testimonial|five[- ]star|5[- ]star|clients love|customers love)\b/i, "no-testimonials", "Do not use testimonials or ratings."],
  [/\b(ai[- ]powered|powered by ai|artificial intelligence|chatgpt|our ai)\b/i, "no-ai-lead", "Do not lead with AI."],
  [/\b(act now|limited time|last chance|urgent|final notice|don'?t miss)\b/i, "no-pressure", "Avoid pressure language."],
  [/\b(free money|100% free|risk[- ]free)\b/i, "no-spam-claims", "Avoid spam-style claims."],
  [/\b(we are|we're)\s+(a\s+)?local\b|\blocal\s+phone\b/i, "no-local-claim", "Do not present BWE as local or give a local phone number."],
];

// Courteous phrases that are fine to say but that some spam filters score. Shown as a
// warning only: "There's no obligation" in a polite closing should not block approval.
const SPAM_FILTER_PHRASES: RegExp[] = [/\bno obligation\b/i];

/** Phrases the drafting prompt tells the model to avoid, kept beside the rules that check them. */
export const PHRASES_TO_AVOID = ["guarantees about rankings, traffic or sales", "free money", "100% free", "risk-free", "no obligation", "act now", "limited time", "last chance", "urgent", "don't miss"];

const GENERIC_AI_PHRASES: RegExp[] = [
  /\bi hope this (email|message) finds you well\b/i,
  /\bin today'?s (fast[- ]paced|digital) (world|landscape)\b/i,
  /\bunlock the (full )?potential\b/i,
  /\btake your (business|brand) to the next level\b/i,
  /\bleverage\b/i,
  /\bdelve\b/i,
  /\bgame[- ]chang(er|ing)\b/i,
];

export function validateDraft(d: DraftInput): DraftValidation {
  const errors: DraftFinding[] = [];
  const warnings: DraftFinding[] = [];
  const text = [d.subject, d.body, d.followUpBody ?? ""].join("\n");

  if (!d.subject.trim()) errors.push({ rule: "subject", message: "The subject is empty." });
  if (d.subject.length > 120) warnings.push({ rule: "subject-length", message: "The subject is long; keep it under about 70 characters." });
  if (/^\s*(re|fwd?):/i.test(d.subject)) errors.push({ rule: "fake-reply", message: "Do not fake a reply or forward in the subject." });
  if (d.body.trim().length < 80) errors.push({ rule: "too-short", message: "The message is too short to be useful." });
  if (d.body.length > 2200) warnings.push({ rule: "too-long", message: "The message is long; cold email works best short." });

  // Footer: unsubscribe line and postal address are required (CAN-SPAM).
  if (!d.body.includes(d.unsubscribeMarker)) errors.push({ rule: "unsubscribe", message: "The unsubscribe line is missing." });
  if (!d.body.includes(d.mailingAddressMarker)) errors.push({ rule: "mailing-address", message: "The mailing address line is missing." });

  for (const [re, rule, message] of PROHIBITED) {
    const m = text.match(re);
    if (m) errors.push({ rule, message: `${message} Found: "${m[0].trim().slice(0, 60)}".` });
  }
  for (const re of SPAM_FILTER_PHRASES) {
    const m = text.match(re);
    if (m) warnings.push({ rule: "spam-filter-phrase", message: `"${m[0]}" is fine to say, but some spam filters flag it. "No pressure" reads the same and is safer.` });
  }
  for (const re of GENERIC_AI_PHRASES) {
    const m = text.match(re);
    if (m) warnings.push({ rule: "generic-phrasing", message: `Generic phrasing: "${m[0]}". Say it plainly.` });
  }

  // A prospecting signal means the business did not ask for help: never imply they did.
  if (d.signalType === "prospecting" && /\b(you|your team)\s+(asked|requested|reached out|contacted us|were looking|are looking|mentioned (needing|looking))\b|\bsaw (that )?you (were|are) (looking|searching)\b|\bin response to your\b/i.test(text)) {
    errors.push({ rule: "implied-request", message: "This is a prospecting signal: do not imply the business asked for help." });
  }

  // Named businesses and sites: only the prospect itself may be named as a fact about its site.
  if (!mentionsBusiness(d.body, d.prospect.businessName, d.prospect.websiteHost)) {
    warnings.push({ rule: "no-business-name", message: "The message does not mention the business by name." });
  }
  const urls = [...text.matchAll(/https?:\/\/[^\s)>\]]+/gi)].map((m) => m[0]);
  for (const u of urls) {
    let host = "";
    try {
      host = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    const allowed = host === d.prospect.websiteHost || host.endsWith("businesswebexpress.com");
    if (!allowed) warnings.push({ rule: "unknown-link", message: `Link to ${host} is not the prospect's site or BWE's.` });
  }
  // Specific numbers about the prospect's site must come from a measurement we recorded; flag them for the person.
  if (/\b\d{1,3}\s?(%|percent)\b|\b\d+(\.\d+)?\s?(seconds?|s)\s+to load\b/i.test(d.body)) {
    warnings.push({ rule: "unverified-number", message: "The message states a number about the site. Check it against the recorded PageSpeed result." });
  }

  return { ok: errors.length === 0, errors, warnings };
}

const LEGAL_SUFFIXES = new Set(["llc", "l", "c", "inc", "incorporated", "co", "corp", "corporation", "company", "ltd", "pllc", "pc", "llp"]);

/** Lowercase words with punctuation removed ("&" becomes "and"). */
function words(s: string): string[] {
  return s.toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * True when the body names the business: its name without legal suffixes or
 * punctuation (any case), the name run together ("compasshvac"), or its website
 * host with or without the ending ("compasshvac.com", "compasshvac").
 */
export function mentionsBusiness(body: string, businessName: string, websiteHost: string | null): boolean {
  const bodyWords = words(body);
  const bodyPhrase = ` ${bodyWords.join(" ")} `;
  const bodySquashed = bodyWords.join("");
  const core = words(businessName);
  while (core.length > 1 && LEGAL_SUFFIXES.has(core[core.length - 1] ?? "")) core.pop();
  if (core.length > 1 && core[0] === "the") core.shift();
  if (core.length > 0) {
    if (bodyPhrase.includes(` ${core.join(" ")} `)) return true;
    const squashed = core.join("");
    if (core.length > 1 && squashed.length >= 6 && bodySquashed.includes(squashed)) return true;
  }
  const host = (websiteHost ?? "").toLowerCase().replace(/^www\./, "");
  if (host) {
    if (body.toLowerCase().includes(host)) return true;
    const stem = (host.split(".")[0] ?? "").replace(/[^a-z0-9]/g, "");
    if (stem.length >= 4 && bodyWords.includes(stem)) return true;
  }
  return false;
}
