// Ranking for the morning package (plan section 10): up to five actions,
// follow-ups that are due first, then opportunities by score x urgency / effort.
// Pure and deterministic; fewer than five items when fewer verified items exist.
export const RANKING_VERSION = "ranking-v1";
export const MAX_ITEMS = 5;

export type Effort = "low" | "medium" | "high";

export type FollowUpCandidate = {
  kind: "follow_up";
  followUpId: string;
  prospectId: string;
  businessName: string;
  dueDate: string; // YYYY-MM-DD
  doNotContact: boolean;
};

export type OpportunityCandidate = {
  kind: "opportunity";
  opportunityId: string;
  businessName: string;
  status: "new" | "saved" | "pursuing";
  score: number; // 0-100
  signalType: "buying_intent" | "prospecting";
  urgency: "high" | "medium" | "low" | "unknown";
  hasEmail: boolean;
  alreadyInTodaysPackage: boolean;
  doNotContact: boolean;
  /** Times this opportunity was in an earlier package and left unfinished. */
  timesCarried: number;
};

export type RankedItem = {
  kind: "follow_up" | "opportunity";
  followUpId?: string;
  opportunityId?: string;
  prospectId?: string;
  businessName: string;
  recommendedAction: string;
  effort: Effort;
  importance: number; // 1-10
  rankScore: number;
};

const URGENCY: Record<OpportunityCandidate["urgency"], number> = { high: 1.3, medium: 1.0, low: 0.8, unknown: 0.9 };
const EFFORT_DIVISOR: Record<Effort, number> = { low: 1, medium: 1.25, high: 1.6 };
/** Opportunities carried this many times without action are flagged stale, not recycled. */
export const STALE_AFTER_CARRIES = 3;

export function rankCandidates(
  today: string,
  followUps: FollowUpCandidate[],
  opportunities: OpportunityCandidate[],
): RankedItem[] {
  const items: RankedItem[] = [];

  for (const f of followUps) {
    if (f.doNotContact || f.dueDate > today) continue;
    const daysLate = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${f.dueDate}T00:00:00Z`)) / 86_400_000));
    items.push({
      kind: "follow_up",
      followUpId: f.followUpId,
      prospectId: f.prospectId,
      businessName: f.businessName,
      recommendedAction: daysLate > 0 ? `Follow up with ${f.businessName} (${daysLate} day${daysLate === 1 ? "" : "s"} overdue).` : `Follow up with ${f.businessName} today.`,
      effort: "low",
      importance: Math.min(10, 8 + Math.min(2, daysLate)),
      // Follow-ups due rank above every opportunity: 1000 is above any opportunity score.
      rankScore: 1000 + daysLate,
    });
  }

  for (const o of opportunities) {
    if (o.alreadyInTodaysPackage || o.doNotContact) continue;
    if (o.timesCarried >= STALE_AFTER_CARRIES) continue;
    const effort: Effort = o.hasEmail ? "low" : "medium";
    const base = (o.score * URGENCY[o.urgency]) / EFFORT_DIVISOR[effort];
    const rankScore = Math.round((base + (o.status === "pursuing" ? 8 : 0)) * 1000) / 1000;
    items.push({
      kind: "opportunity",
      opportunityId: o.opportunityId,
      businessName: o.businessName,
      recommendedAction:
        o.signalType === "buying_intent"
          ? `${o.businessName} asked for website help: review the page and reply${o.hasEmail ? " (draft prepared)" : ""}.`
          : `${o.businessName} may benefit from a better website: review the evidence and decide whether to reach out.`,
      effort,
      importance: Math.max(1, Math.min(10, Math.round(o.score / 10))),
      rankScore,
    });
  }

  return items
    .sort((a, b) => b.rankScore - a.rankScore || a.businessName.localeCompare(b.businessName))
    .slice(0, MAX_ITEMS);
}
