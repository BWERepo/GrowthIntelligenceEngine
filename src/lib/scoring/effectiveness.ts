// Daily Effectiveness Score, rule set des-v1 (plan section 9.2). Pure and
// deterministic: the same recorded facts and rules always give the same score.
// "How meaningful was today's work?" It is never combined with the Opportunity
// Score or the 30-Day Growth panel.
//
// A component is either measured (it has points) or not measured (nothing
// recorded to measure, e.g. no emails sent). Unmeasured components are left out
// and the score says how complete it is; below the minimum completeness the
// score is "unavailable", never zero.
export const RULE_VERSION = "des-v1";

export type ComponentKey = "business_outcomes" | "action_quality" | "follow_up_discipline" | "priority_execution" | "opportunity_management";

export type Rules = {
  version: string;
  weights: Record<ComponentKey, number>;
  /** Share of the 100 points that must be measurable for a score to be shown. */
  minCompleteness: number;
  /** Weights of the four checks on each email sent (they sum to 1). */
  contactChecks: { verified: number; validatorPassed: number; editedByPerson: number; notDuplicate: number };
  /** Lowest score of each band, highest first. Operational heuristics, labelled as such. */
  bands: Array<{ min: number; label: string }>;
};

export const DEFAULT_RULES: Rules = {
  version: RULE_VERSION,
  weights: { business_outcomes: 40, action_quality: 25, follow_up_discipline: 15, priority_execution: 10, opportunity_management: 10 },
  minCompleteness: 0.5,
  contactChecks: { verified: 0.25, validatorPassed: 0.35, editedByPerson: 0.2, notDuplicate: 0.2 },
  bands: [
    { min: 90, label: "Exceptional" },
    { min: 75, label: "Highly Effective" },
    { min: 60, label: "Productive" },
    { min: 40, label: "Needs Improvement" },
    { min: 0, label: "Low" },
  ],
};

export const COMPONENT_LABEL: Record<ComponentKey, string> = {
  business_outcomes: "Business outcomes",
  action_quality: "Action quality",
  follow_up_discipline: "Follow-up discipline",
  priority_execution: "Priority execution",
  opportunity_management: "Opportunity management",
};

export type DayInputs = {
  /** An action package was built for the day. */
  hasPackage: boolean;
  items: Array<{ id: string; kind: "follow_up" | "opportunity"; importance: number; status: string; managed: boolean }>;
  contacts: Array<{ draftId: string; verified: boolean; validatorPassed: boolean; editedByPerson: boolean; notDuplicate: boolean }>;
  /** Follow-ups due that day (those waiting on someone else's answer already removed). */
  followUps: Array<{ id: string; onTime: boolean }>;
  /** Replies whose one-business-day deadline fell on that day. */
  replies: Array<{ id: string; handledInTime: boolean }>;
  /** Outcome events (meetings, proposals, customers, revenue) are recorded from Phase 6. */
  outcomesTracked: boolean;
};

export type Evidence = { eventType: string; sourceTable: string; sourceId: string; points: number };
export type ComponentResult = { key: ComponentKey; weight: number; measured: boolean; points: number | null; explanation: string; evidence: Evidence[] };
export type DayScore = {
  available: boolean;
  score: number | null;
  band: string | null;
  /** Percent of the 100 points that could be measured. */
  completeness: number;
  reason: string | null;
  components: ComponentResult[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function scoreDay(input: DayInputs, rules: Rules = DEFAULT_RULES): DayScore {
  const w = rules.weights;
  const components: ComponentResult[] = [];

  // Business outcomes: nothing is recorded to measure until outcome tracking exists.
  components.push({
    key: "business_outcomes",
    weight: w.business_outcomes,
    measured: false,
    points: null,
    explanation: input.outcomesTracked ? "No outcome events were recorded for this day." : "Not measured: meetings, proposals, customers and revenue are tracked from Phase 6.",
    evidence: [],
  });

  // Action quality: the average of four checks over the emails sent that day.
  {
    const c = rules.contactChecks;
    if (input.contacts.length === 0) {
      components.push({ key: "action_quality", weight: w.action_quality, measured: false, points: null, explanation: "Not measured: no outreach was sent that day.", evidence: [] });
    } else {
      const each = input.contacts.map((x) => ({ x, q: (x.verified ? c.verified : 0) + (x.validatorPassed ? c.validatorPassed : 0) + (x.editedByPerson ? c.editedByPerson : 0) + (x.notDuplicate ? c.notDuplicate : 0) }));
      const points = r2((each.reduce((s, e) => s + e.q, 0) / each.length) * w.action_quality);
      components.push({
        key: "action_quality",
        weight: w.action_quality,
        measured: true,
        points,
        explanation: `${input.contacts.length} email${input.contacts.length === 1 ? "" : "s"} sent: each scored on a verified prospect, a draft that passed the checks, personal edits, and no duplicate contact.`,
        evidence: each.map((e) => ({ eventType: "email_sent", sourceTable: "gie_outreach_drafts", sourceId: e.x.draftId, points: r2((e.q * w.action_quality) / each.length) })),
      });
    }
  }

  // Follow-up discipline: due follow-ups done on time, and replies handled in one business day.
  {
    const total = input.followUps.length + input.replies.length;
    if (total === 0) {
      components.push({ key: "follow_up_discipline", weight: w.follow_up_discipline, measured: false, points: null, explanation: "Not measured: no follow-up or reply was due that day.", evidence: [] });
    } else {
      const ok = input.followUps.filter((f) => f.onTime).length + input.replies.filter((r) => r.handledInTime).length;
      const each = r2(w.follow_up_discipline / total);
      components.push({
        key: "follow_up_discipline",
        weight: w.follow_up_discipline,
        measured: true,
        points: r2((ok / total) * w.follow_up_discipline),
        explanation: `${ok} of ${total} due follow-up${total === 1 ? "" : "s"} and repl${total === 1 ? "y" : "ies"} handled on time. Items waiting on someone else's answer are left out.`,
        evidence: [
          ...input.followUps.filter((f) => f.onTime).map((f) => ({ eventType: "follow_up_done_on_time", sourceTable: "gie_follow_up_tasks", sourceId: f.id, points: each })),
          ...input.replies.filter((r) => r.handledInTime).map((r) => ({ eventType: "reply_handled_in_time", sourceTable: "gie_outreach_replies", sourceId: r.id, points: each })),
        ],
      });
    }
  }

  // Priority execution: importance completed over importance planned.
  {
    const planned = input.items.reduce((s, i) => s + i.importance, 0);
    if (planned === 0) {
      components.push({ key: "priority_execution", weight: w.priority_execution, measured: false, points: null, explanation: "Not measured: no actions were planned.", evidence: [] });
    } else {
      const done = input.items.filter((i) => i.status === "completed");
      const doneImportance = done.reduce((s, i) => s + i.importance, 0);
      components.push({
        key: "priority_execution",
        weight: w.priority_execution,
        measured: true,
        points: r2((doneImportance / planned) * w.priority_execution),
        explanation: `${done.length} of ${input.items.length} planned actions completed, weighted by importance.`,
        evidence: done.map((i) => ({ eventType: "action_completed", sourceTable: "gie_daily_action_items", sourceId: i.id, points: r2((i.importance / planned) * w.priority_execution) })),
      });
    }
  }

  // Opportunity management: opportunities in the package that were actually decided, not just viewed.
  {
    const opps = input.items.filter((i) => i.kind === "opportunity");
    if (opps.length === 0) {
      components.push({ key: "opportunity_management", weight: w.opportunity_management, measured: false, points: null, explanation: "Not measured: no opportunities were in the day's package.", evidence: [] });
    } else {
      const managed = opps.filter((i) => i.managed);
      components.push({
        key: "opportunity_management",
        weight: w.opportunity_management,
        measured: true,
        points: r2((managed.length / opps.length) * w.opportunity_management),
        explanation: `${managed.length} of ${opps.length} opportunities were worked, or decided with a recorded reason or date.`,
        evidence: managed.map((i) => ({ eventType: "opportunity_managed", sourceTable: "gie_daily_action_items", sourceId: i.id, points: r2(w.opportunity_management / opps.length) })),
      });
    }
  }

  const measuredWeight = components.filter((c) => c.measured).reduce((s, c) => s + c.weight, 0);
  const totalWeight = Object.values(w).reduce((s, n) => s + n, 0);
  const completeness = Math.round((measuredWeight / totalWeight) * 100);
  const none = { score: null, band: null, available: false };
  if (!input.hasPackage) return { ...none, completeness, reason: "No action package was built for this day, so there is nothing to score.", components };
  if (measuredWeight / totalWeight < rules.minCompleteness) {
    return { ...none, completeness, reason: `Insufficient verified activity data: only ${completeness}% of the score could be measured (at least ${Math.round(rules.minCompleteness * 100)}% is needed).`, components };
  }
  const earned = components.reduce((s, c) => s + (c.points ?? 0), 0);
  const score = Math.max(0, Math.min(100, Math.round((earned / measuredWeight) * 100)));
  const band = [...rules.bands].sort((a, b) => b.min - a.min).find((b) => score >= b.min)!.label;
  return { available: true, score, band, completeness, reason: null, components };
}
