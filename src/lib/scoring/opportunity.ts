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

export const OPPORTUNITY_RULE_VERSION = "opportunity-score-v1";

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
};

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

function intent(i: ScoreInputs): [number, string] {
  const base = { explicit_request: 1, strong_indirect: 0.6, weak_indirect: 0.3, none: 0 }[i.intentLevel];
  if (i.signalType === "prospecting") {
    // A weak website is a prospecting signal, not intent: capped at 0.3.
    const v = Math.min(base, 0.3);
    return [v, i.intentLevel === "none" ? "Prospecting signal: no request for help on the page." : `Prospecting signal, intent "${i.intentLevel}" capped at 0.3.`];
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
  if (i.ageDays === null) {
    if (i.signalType === "prospecting") return [1, "Prospecting signal observed on the live site today."];
    return [0, "No publication date was found, so freshness is unknown (0)."];
  }
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
