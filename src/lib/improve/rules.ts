// Continuous improvement: deterministic suggestions from recorded data, each with the facts
// behind it, and a plain verdict on whether a carried-out suggestion was followed by a better
// result. The app only suggests and measures: a person decides, and makes any change themselves.
import { compare, type ScenarioFlag } from "@/lib/growth/metrics";

export type RuleKey = "campaign_no_replies" | "campaign_outperforms" | "campaign_finds_nothing" | "growth_flag";
export type Metric = "replied" | "opportunity" | "lead";
export type Evidence = { label: string; value: string; source: string };

export type CampaignStats = {
  id: string;
  name: string;
  /** Days since the campaign was created. */
  ageDays: number;
  /** Over the last 30 days. */
  opportunities: number;
  contacted: number;
  replied: number;
};

export type RecommendationDraft = {
  ruleKey: RuleKey;
  subjectKey: string;
  campaignId: string | null;
  title: string;
  rationale: string;
  evidence: Evidence[];
  metric: Metric;
};

/** A campaign needs this many contacts in 30 days before its reply rate means anything. */
export const MIN_CONTACTED = 20;
/** Smaller bar for the better-than-the-rest comparison, applied to both sides. */
export const MIN_CONTACTED_COMPARE = 10;
export const MIN_AGE_DAYS = 30;
export const OUTPERFORM_FACTOR = 2;
/** After a rejected or carried-out suggestion, the same one is not raised again for this long. */
export const COOLDOWN_DAYS = 30;
export const OUTCOME_DAYS = 30;

const SRC = "Growth Intelligence Engine records, last 30 days";
const rate = (n: number, d: number) => (d > 0 ? n / d : null);
const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

const FLAG_ADVICE: Record<ScenarioFlag["key"], { title: string; rationale: string }> = {
  A: { title: "Review who the outreach is going to", rationale: "More emails are going out but results have not risen. Look at who is being contacted and what is being said before sending more." },
  B: { title: "Find out what is driving the growth", rationale: "Results are up without more outreach, so the growth is probably coming from elsewhere. Knowing where from lets you do more of it." },
  C: { title: "Check how visitors become enquiries", rationale: "More people are visiting the site but no more are getting in touch. Check the contact path, the calls to action and what the busiest pages ask of visitors." },
  D: { title: "Check that daily actions lead to business", rationale: "Days are scoring well but results are falling, so the work being done may not be the work that wins customers." },
};

export function recommend(campaigns: CampaignStats[], flags: ScenarioFlag[]): RecommendationDraft[] {
  const out: RecommendationDraft[] = [];
  for (const c of campaigns) {
    if (c.ageDays >= MIN_AGE_DAYS && c.contacted >= MIN_CONTACTED && c.replied === 0) {
      out.push({
        ruleKey: "campaign_no_replies",
        subjectKey: c.id,
        campaignId: c.id,
        title: `Revisit the "${c.name}" campaign's outreach`,
        rationale: "Plenty of emails have gone out and nobody has replied. The targets, the signal or the message may be wrong; this is a prompt to look, not proof of which.",
        evidence: [
          { label: "Emails sent (30 days)", value: String(c.contacted), source: SRC },
          { label: "Replies (30 days)", value: "0", source: SRC },
          { label: "Campaign age", value: `${c.ageDays} days`, source: SRC },
        ],
        metric: "replied",
      });
    }
    if (c.ageDays >= MIN_AGE_DAYS && c.opportunities === 0) {
      out.push({
        ruleKey: "campaign_finds_nothing",
        subjectKey: c.id,
        campaignId: c.id,
        title: `Review the "${c.name}" campaign's search terms`,
        rationale: "No verified opportunities were found in 30 days. The queries, industries or places may be too narrow or no longer match how businesses describe the need.",
        evidence: [
          { label: "Verified opportunities (30 days)", value: "0", source: SRC },
          { label: "Campaign age", value: `${c.ageDays} days`, source: SRC },
        ],
        metric: "opportunity",
      });
    }
  }
  for (const c of campaigns) {
    const others = campaigns.filter((o) => o.id !== c.id);
    const oc = others.reduce((t, o) => t + o.contacted, 0);
    const orp = others.reduce((t, o) => t + o.replied, 0);
    const mine = rate(c.replied, c.contacted);
    const theirs = rate(orp, oc);
    if (!others.length || c.contacted < MIN_CONTACTED_COMPARE || oc < MIN_CONTACTED_COMPARE || c.replied < 3 || mine === null || theirs === null || theirs <= 0) continue;
    if (mine >= theirs * OUTPERFORM_FACTOR) {
      out.push({
        ruleKey: "campaign_outperforms",
        subjectKey: c.id,
        campaignId: c.id,
        title: `Put more effort into the "${c.name}" campaign`,
        rationale: `It is getting replies at ${(mine / theirs).toFixed(1)} times the rate of the other campaigns. Replies are not customers, so check what happens to them before shifting effort.`,
        evidence: [
          { label: `"${c.name}" reply rate`, value: `${pct(mine)} (${c.replied} of ${c.contacted})`, source: SRC },
          { label: "Other campaigns' reply rate", value: `${pct(theirs)} (${orp} of ${oc})`, source: SRC },
        ],
        metric: "replied",
      });
    }
  }
  for (const f of flags) {
    if (f.status !== "raised") continue;
    out.push({
      ruleKey: "growth_flag",
      subjectKey: f.key,
      campaignId: null,
      title: FLAG_ADVICE[f.key].title,
      rationale: FLAG_ADVICE[f.key].rationale,
      evidence: [{ label: f.title, value: f.detail, source: "30-Day Growth report" }],
      metric: "lead",
    });
  }
  return out;
}

export type Verdict = "improved" | "worse" | "no_change" | "insufficient_evidence";
export type Outcome = { verdict: Verdict; before: number; after: number; note: string };

/** Same measure, 30 days before and 30 days after. This shows what happened, not that the change caused it. */
export function judgeOutcome(before: number, after: number, minEvents?: number): Outcome {
  const c = compare(after, before, { minEvents });
  const verdict: Verdict = c.trend === "up" ? "improved" : c.trend === "down" ? "worse" : c.trend === "flat" ? "no_change" : "insufficient_evidence";
  const base = verdict === "insufficient_evidence" ? "Too few events in one of the two periods to call a result." : `${before} before, ${after} after.`;
  return { verdict, before, after, note: `${base} Other things changed over the same period, so this is not proof the change caused it.` };
}
