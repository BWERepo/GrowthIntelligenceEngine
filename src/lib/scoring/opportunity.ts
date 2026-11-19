// Opportunity Score v1: "How promising is this lead?" (plan section 9.1).
//
//   score = round(35·intent + 30·fit + 15·freshness + 10·reachability + 10·evidence)
//
// Each part is a number from 0 to 1 computed here, in code, from the checked
// classification and from facts the code found itself (contact links, dates).
// The AI never outputs the number. Pure and deterministic: the same inputs
// always give the same score, and every score row stores these inputs.
//
// This is one of three separate measurements. It is never combined with the
// Daily Effectiveness Score or 30-Day Growth.

export const OPPORTUNITY_RULE_VERSION = "opportunity-score-v2";
// v2: for prospecting signals, intent (capped at 0.3) comes from the measured
// weaknesses of the business's own website, and freshness is the day the live
// site was observed, not the age of the page (an old page is the signal itself).

export const WEIGHTS = { intent: 35, fit: 30, freshness: 15, reachability: 10, evidence: 10 } as const;
export type Component = keyof typeof WEIGHTS;

export type Band = "very_high" | "high" | "review" | "low";
export const BAND_LABELS: Record<Band, string> = { very_high: "Very high", high: "High", review: "Review", low: "Low" };

export type ScoreInputs = {
  signalType: "buying_intent" | "prospecting";
  intentLevel: "explicit_request" | "strong_indirect" | "weak_indirect" | "none";
  industry: string | null;
  location: string | null;
  businessSize: "small" | "medium" | "large" | "unknown";
  offerMatch: "new_website" | "redesign" | "seo_or_marketing" | "other" | "none";
  campaignIndustries: string[];
  campaignLocations: string[];
  /** Age in days of the signal, when a date is known. */
  ageDays: number | null;
  maxAgeDays: number;
  /** Contact channels found in the business's own page markup. */
  contact: { emails: number; phones: number; hasContactForm: boolean } | null;
  /** True when the contact channels above come from the business's own site. */
  contactOnOwnSite: boolean;
  /** Quoted claims that were checked and found, and claims made in total. */
  backedClaims: number;
  totalClaims: number;
  confidence: number;
  /** Prospecting only: measured facts about the business's own website, or null when none were measured. */
  siteWeakness?: SiteWeakness | null;
};

/** Measured facts about a prospect's own website (PageSpeed mobile, link check, the URL itself). */
export type SiteWeakness = {
  /** PageSpeed mobile performance, 0-100, or null when not measured. */
  mobilePerformance: number | null;
  /** PageSpeed mobile SEO, 0-100, or null when not measured. */
  mobileSeo: number | null;
  /** Same-site links from the homepage that answered 404/410, and how many were checked. */
  brokenLinks: number;
  linksChecked: number;
  /** False when the business's site was reached over plain http. */
  https: boolean | null;
};

export const WEAK_PERFORMANCE_BELOW = 50;
export const WEAK_SEO_BELOW = 70;
/** Each measured weakness adds this much prospecting intent, up to the 0.3 cap. */
const WEAKNESS_STEP = 0.1;

export type ScoreComponent = { component: Component; weight: number; value: number; points: number; explanation: string };
export type OpportunityScore = { ruleVersion: string; score: number; band: Band; components: ScoreComponent[] };

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function bandFor(score: number): Band {
  if (score >= 85) return "very_high";
  if (score >= 70) return "high";
  if (score >= 50) return "review";
  return "low";
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function siteWeaknesses(w: SiteWeakness | null | undefined): string[] {
  if (!w) return [];
  const out: string[] = [];
  if (w.mobilePerformance !== null && w.mobilePerformance < WEAK_PERFORMANCE_BELOW) out.push(`mobile speed ${w.mobilePerformance}/100`);
  if (w.mobileSeo !== null && w.mobileSeo < WEAK_SEO_BELOW) out.push(`mobile SEO ${w.mobileSeo}/100`);
  if (w.brokenLinks > 0) out.push(`${w.brokenLinks} of ${w.linksChecked} homepage links broken`);
  if (w.https === false) out.push("no HTTPS");
  return out;
}

function intent(i: ScoreInputs): [number, string] {
  const base = { explicit_request: 1, strong_indirect: 0.6, weak_indirect: 0.3, none: 0 }[i.intentLevel];
  if (i.signalType === "prospecting") {
    // A weak website is a prospecting signal, not intent: capped at 0.3. The
    // weakness must be measured (PageSpeed, link check, http), never assumed.
    const weak = siteWeaknesses(i.siteWeakness);
    const v = Math.min(0.3, Math.max(base, weak.length * WEAKNESS_STEP));
    if (weak.length) return [v, `Prospecting signal: measured weaknesses (${weak.join(", ")}), capped at 0.3.`];
    if (!i.siteWeakness) return [Math.min(base, 0.3), i.intentLevel === "none" ? "Prospecting signal: the website was not measured, so no weakness is counted." : `Prospecting signal, intent "${i.intentLevel}" capped at 0.3.`];
    return [Math.min(base, 0.3), i.intentLevel === "none" ? "Prospecting signal: the website was measured and no weakness was found." : `Prospecting signal, intent "${i.intentLevel}" capped at 0.3.`];
  }
  const text = {
    explicit_request: "The business explicitly asks for website help.",
    strong_indirect: "Strong indirect signal of a website need.",
    weak_indirect: "Only a weak hint of a website need.",
    none: "No sign that the business is asking for help.",
  }[i.intentLevel];
  return [base, text];
}

function fit(i: ScoreInputs): [number, string] {
  const parts: string[] = [];
  let v = 0;
  const industries = i.campaignIndustries.map(norm);
  if (i.industry && industries.includes(norm(i.industry))) {
    v += 0.4;
    parts.push(`industry ${i.industry} is served`);
  } else {
    parts.push(i.industry ? `industry ${i.industry} is not in the campaign` : "industry unknown");
  }
  // A location matches when its city (the part before the comma) appears in a campaign location, or the reverse.
  const loc = i.location ? norm(i.location.split(",")[0] ?? i.location) : "";
  const locMatch = !!loc && i.campaignLocations.some((c) => {
    const city = norm(c.split(",")[0] ?? c);
    return city.length > 0 && (loc.includes(city) || city.includes(loc));
  });
  if (locMatch) {
    v += 0.3;
    parts.push(`in ${i.location}`);
  } else {
    parts.push(i.location ? `${i.location} is outside the campaign area` : "location unknown");
  }
  if (i.businessSize === "small") {
    v += 0.2;
    parts.push("small business");
  } else {
    parts.push(i.businessSize === "unknown" ? "size unknown" : `${i.businessSize} business`);
  }
  if (i.offerMatch === "new_website" || i.offerMatch === "redesign") {
    v += 0.1;
    parts.push(i.offerMatch === "new_website" ? "needs a new website" : "needs a redesign");
  }
  return [v, `Fit: ${parts.join(", ")}.`];
}

function freshness(i: ScoreInputs): [number, string] {
  // A prospecting signal is the state of the live site, observed today. The page's
  // own age (a 2019 copyright, the search engine's page date) is not the signal's age.
  if (i.signalType === "prospecting") return [1, "Prospecting signal observed on the live site today."];
  if (i.ageDays === null) return [0, "No publication date was found, so freshness is unknown (0)."];
  const age = Math.max(0, i.ageDays);
  if (age <= 3) return [1, `Published ${age} day(s) ago.`];
  const max = Math.max(4, i.maxAgeDays);
  if (age >= max) return [0, `Published ${age} days ago, past the ${max}-day limit.`];
  return [1 - (age - 3) / (max - 3), `Published ${age} days ago (fades to 0 at ${max} days).`];
}

function reachability(i: ScoreInputs): [number, string] {
  if (!i.contact || !i.contactOnOwnSite) return [0, "No contact channel found on the business's own site."];
  if (i.contact.emails > 0 || i.contact.phones > 0) return [1, "Public email or phone on the business's own site."];
  if (i.contact.hasContactForm) return [0.6, "Only a contact form on the business's own site."];
  return [0, "No contact channel found on the business's own site."];
}

function evidence(i: ScoreInputs): [number, string] {
  if (i.totalClaims <= 0) return [0, "No claims could be checked."];
  const share = Math.min(1, i.backedClaims / i.totalClaims);
  const v = share * clamp01(i.confidence);
  return [v, `${i.backedClaims} of ${i.totalClaims} claims backed by exact quotes, confidence ${clamp01(i.confidence).toFixed(2)}.`];
}

export function scoreOpportunity(inputs: ScoreInputs): OpportunityScore {
  const parts: Array<[Component, [number, string]]> = [
    ["intent", intent(inputs)],
    ["fit", fit(inputs)],
    ["freshness", freshness(inputs)],
    ["reachability", reachability(inputs)],
    ["evidence", evidence(inputs)],
  ];
  const components = parts.map(([component, [raw, explanation]]) => {
    const value = round4(clamp01(raw));
    const weight = WEIGHTS[component];
    return { component, weight, value, points: Math.round(weight * value * 100) / 100, explanation };
  });
  const score = Math.round(components.reduce((s, c) => s + c.weight * c.value, 0));
  return { ruleVersion: OPPORTUNITY_RULE_VERSION, score, band: bandFor(score), components };
}

/** Whole days between two instants (floor), for freshness. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
