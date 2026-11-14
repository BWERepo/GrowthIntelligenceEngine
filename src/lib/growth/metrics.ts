// 30-Day Growth Performance: the last 30 tenant-local days ending yesterday against the
// 30 days before them. Pure functions over recorded events, so every rule is tested
// without a database. This is the primary measurement and is never blended with the
// Opportunity Score or the Daily Effectiveness Score.
import { localMoment } from "@/lib/schedule";

export const WINDOW_DAYS = 30;
/** Fewer events than this in either period is "insufficient evidence": counts are shown, no trend. */
export const MIN_EVENTS = 10;
/** A change smaller than this (in percent) is called flat, not a trend. */
export const FLAT_BELOW_PERCENT = 5;
/** Scenario flags only fire on changes of at least this many percent. */
export const FLAG_PERCENT = 10;
/** The Daily Effectiveness average needs at least this many finalized days to be quoted. */
export const MIN_SCORED_DAYS = 5;
export const HIGH_EFFECTIVENESS = 75;

export const STAGES = ["opportunity", "pursued", "contacted", "replied", "lead", "meeting", "proposal", "agreement", "deposit", "customer"] as const;
export type Stage = (typeof STAGES)[number];
/** Stages read from BWE's own records; a workspace without that connection cannot measure them. */
export const BWE_STAGES: Stage[] = ["lead", "meeting", "proposal", "agreement", "deposit", "customer"];

export const STAGE_LABEL: Record<Stage, string> = {
  opportunity: "Verified opportunities",
  pursued: "Pursued",
  contacted: "Contacted",
  replied: "Replies received",
  lead: "Leads",
  meeting: "Meetings",
  proposal: "Proposals sent",
  agreement: "Agreements signed",
  deposit: "Deposits paid",
  customer: "New customers",
};

export type Attribution = "first_touch" | "last_touch" | "assisted" | "unknown";
export type Confidence = "high" | "medium" | "low" | "none";

export type FunnelEvent = {
  stage: Stage;
  sourceTable: string;
  sourceId: string;
  occurredAt: string;
  prospectId: string | null;
  attribution: Attribution;
  confidence: Confidence;
};
export type RevenueEvent = {
  paymentId: string;
  paidAt: string;
  amountCents: number;
  currency: string;
  prospectId: string | null;
  attribution: Attribution;
  confidence: Confidence;
};

export type Period = { from: string; to: string };

const DAY = 86_400_000;
export const shiftDate = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Current period ends yesterday (tenant-local); the previous period is the same length right before it. */
export function periodsFor(today: string, days = WINDOW_DAYS): { current: Period; previous: Period } {
  const to = shiftDate(today, -1);
  const from = shiftDate(to, -(days - 1));
  const prevTo = shiftDate(from, -1);
  return { current: { from, to }, previous: { from: shiftDate(prevTo, -(days - 1)), to: prevTo } };
}

export const inPeriod = (localDate: string, p: Period) => localDate >= p.from && localDate <= p.to;
export const localDateOf = (iso: string, timezone: string) => localMoment(new Date(iso), timezone).date;

export type Trend = "up" | "down" | "flat" | "insufficient";
export type Comparison = {
  current: number;
  previous: number;
  change: number;
  /** Only when the previous period is above zero and both periods have enough events. */
  percent: number | null;
  /** Why there is no percent, when there is none. */
  note: string | null;
  trend: Trend;
  sufficient: boolean;
};

/**
 * `evidence` is the number of recorded events behind each value (for revenue, payments rather than cents).
 * Defaults to the values themselves for plain counts.
 */
export function compare(current: number, previous: number, opts: { minEvents?: number; evidence?: { current: number; previous: number } } = {}): Comparison {
  const min = opts.minEvents ?? MIN_EVENTS;
  const ev = opts.evidence ?? { current, previous };
  const sufficient = ev.current >= min && ev.previous >= min;
  const change = current - previous;
  if (previous <= 0) return { current, previous, change, percent: null, note: "n/a: no baseline", trend: "insufficient", sufficient };
  if (!sufficient) return { current, previous, change, percent: null, note: "Insufficient evidence", trend: "insufficient", sufficient };
  const percent = Math.round((change / previous) * 1000) / 10;
  const trend: Trend = Math.abs(percent) < FLAT_BELOW_PERCENT ? "flat" : percent > 0 ? "up" : "down";
  return { current, previous, change, percent, note: null, trend, sufficient };
}

export type MetricRow = {
  key: Stage | "revenue" | "attributed_revenue";
  label: string;
  unit: "count" | "usd_cents";
  /** False when this workspace has no record source for it; it is then shown as not connected, never as zero. */
  measured: boolean;
  source: string;
  comparison: Comparison | null;
};

export type ConversionRow = { label: string; from: Stage; to: Stage; current: Ratio; previous: Ratio };
export type Ratio = { numerator: number; denominator: number; rate: number | null };

export type CohortView = {
  /** Prospects first pursued in the current period, and how far they have since got (any date). */
  size: number;
  sufficient: boolean;
  contacted: number;
  replied: number;
  leads: number;
  customers: number;
  revenueCents: number;
};

export type FlagStatus = "raised" | "clear" | "not_evaluated";
export type ScenarioFlag = { key: "A" | "B" | "C" | "D"; title: string; status: FlagStatus; detail: string };

export type GrowthInput = {
  today: string;
  timezone: string;
  funnel: FunnelEvent[];
  revenue: RevenueEvent[];
  /** True when BWE's records are readable for this workspace. */
  bweConnected: boolean;
  /** Unique site visit sessions per period, or null when not recorded for this workspace. */
  visits: { current: number; previous: number } | null;
  /** Finalized Daily Effectiveness scores that were available, per period. */
  effectiveness: { current: { days: number; average: number | null }; previous: { days: number; average: number | null } } | null;
  minEvents?: number;
  windowDays?: number;
};

export type GrowthReport = {
  asOfDate: string;
  windowDays: number;
  minEvents: number;
  current: Period;
  previous: Period;
  metrics: MetricRow[];
  conversions: ConversionRow[];
  cohort: CohortView | null;
  revenue: {
    currency: "usd";
    totalCents: Period2<number>;
    attributedCents: Period2<number>;
    highConfidenceCents: Period2<number>;
    unattributedCents: Period2<number>;
    otherCurrencyPayments: number;
  } | null;
  visits: { current: number; previous: number; comparison: Comparison } | null;
  flags: ScenarioFlag[];
  /** Plain-language reasons the picture is incomplete. */
  caveats: string[];
};
type Period2<T> = { current: T; previous: T };

const ratio = (numerator: number, denominator: number): Ratio => ({ numerator, denominator, rate: denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null });

const CONVERSIONS: Array<[Stage, Stage, string]> = [
  ["contacted", "replied", "Contacted to replied"],
  ["lead", "meeting", "Lead to meeting"],
  ["meeting", "proposal", "Meeting to proposal"],
  ["proposal", "agreement", "Proposal to agreement"],
  ["agreement", "deposit", "Agreement to deposit"],
];

const pctChange = (current: number, previous: number): number | null => (previous > 0 ? ((current - previous) / previous) * 100 : null);

export function buildReport(input: GrowthInput): GrowthReport {
  const min = input.minEvents ?? MIN_EVENTS;
  const windowDays = input.windowDays ?? WINDOW_DAYS;
  const { current, previous } = periodsFor(input.today, windowDays);

  // One recorded fact counts once, even if it was handed over twice.
  const seen = new Set<string>();
  const funnel = input.funnel.filter((e) => {
    const k = `${e.stage}|${e.sourceTable}|${e.sourceId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const seenPay = new Set<string>();
  const revenue = input.revenue.filter((r) => (seenPay.has(r.paymentId) ? false : (seenPay.add(r.paymentId), true)));

  const side = (iso: string): "current" | "previous" | null => {
    const d = localDateOf(iso, input.timezone);
    return inPeriod(d, current) ? "current" : inPeriod(d, previous) ? "previous" : null;
  };
  const count = Object.fromEntries(STAGES.map((s) => [s, { current: 0, previous: 0 }])) as Record<Stage, Period2<number>>;
  for (const e of funnel) {
    const s = side(e.occurredAt);
    if (s) count[e.stage][s] += 1;
  }

  const metrics: MetricRow[] = STAGES.map((stage) => {
    const bwe = BWE_STAGES.includes(stage);
    const measured = !bwe || input.bweConnected;
    return {
      key: stage,
      label: STAGE_LABEL[stage],
      unit: "count" as const,
      measured,
      source: bwe ? "Business Web Express records" : "Growth Intelligence Engine records",
      comparison: measured ? compare(count[stage].current, count[stage].previous, { minEvents: min }) : null,
    };
  });

  // Revenue: whole US dollars in cents; other currencies are counted but never added in.
  const usd = revenue.filter((r) => r.currency === "usd");
  const sum = (rows: RevenueEvent[], which: "current" | "previous") => rows.filter((r) => side(r.paidAt) === which).reduce((t, r) => t + r.amountCents, 0);
  const n = (rows: RevenueEvent[], which: "current" | "previous") => rows.filter((r) => side(r.paidAt) === which).length;
  const attributed = usd.filter((r) => r.attribution !== "unknown");
  const high = usd.filter((r) => r.attribution !== "unknown" && r.confidence === "high");
  const both = (rows: RevenueEvent[]) => ({ current: sum(rows, "current"), previous: sum(rows, "previous") });
  const revenueBlock = input.bweConnected
    ? {
        currency: "usd" as const,
        totalCents: both(usd),
        attributedCents: both(attributed),
        highConfidenceCents: both(high),
        unattributedCents: { current: sum(usd, "current") - sum(attributed, "current"), previous: sum(usd, "previous") - sum(attributed, "previous") },
        otherCurrencyPayments: revenue.filter((r) => r.currency !== "usd" && side(r.paidAt)).length,
      }
    : null;
  metrics.push({
    key: "revenue",
    label: "Revenue (paid)",
    unit: "usd_cents",
    measured: input.bweConnected,
    source: "Business Web Express payments",
    comparison: revenueBlock ? compare(revenueBlock.totalCents.current, revenueBlock.totalCents.previous, { minEvents: min, evidence: { current: n(usd, "current"), previous: n(usd, "previous") } }) : null,
  });
  metrics.push({
    key: "attributed_revenue",
    label: "Revenue linked to a prospect",
    unit: "usd_cents",
    measured: input.bweConnected,
    source: "Payments matched to a Growth Intelligence prospect",
    comparison: revenueBlock ? compare(revenueBlock.attributedCents.current, revenueBlock.attributedCents.previous, { minEvents: min, evidence: { current: n(attributed, "current"), previous: n(attributed, "previous") } }) : null,
  });

  const conversions: ConversionRow[] = CONVERSIONS.filter(([from, to]) => !(BWE_STAGES.includes(from) || BWE_STAGES.includes(to)) || input.bweConnected).map(([from, to, label]) => ({
    label,
    from,
    to,
    current: ratio(count[to].current, count[from].current),
    previous: ratio(count[to].previous, count[from].previous),
  }));

  // Cohort view: of prospects first pursued in the current period, how far did they get (on any date)?
  const pursuedIds = new Set(funnel.filter((e) => e.stage === "pursued" && e.prospectId && side(e.occurredAt) === "current").map((e) => e.prospectId!));
  const reached = (stage: Stage) => new Set(funnel.filter((e) => e.stage === stage && e.prospectId && pursuedIds.has(e.prospectId)).map((e) => e.prospectId!)).size;
  const cohort: CohortView | null = {
    size: pursuedIds.size,
    sufficient: pursuedIds.size >= min,
    contacted: reached("contacted"),
    replied: reached("replied"),
    leads: reached("lead"),
    customers: reached("customer"),
    revenueCents: usd.filter((r) => r.prospectId && pursuedIds.has(r.prospectId)).reduce((t, r) => t + r.amountCents, 0),
  };

  const visits = input.visits ? { ...input.visits, comparison: compare(input.visits.current, input.visits.previous, { minEvents: min }) } : null;

  // Outcomes in one number for the flags: leads, meetings, proposals and new customers.
  const outcome = (which: "current" | "previous") => count.lead[which] + count.meeting[which] + count.proposal[which] + count.customer[which];
  const outcomes = input.bweConnected ? compare(outcome("current"), outcome("previous"), { minEvents: min }) : null;
  const contacted = metrics.find((m) => m.key === "contacted")!.comparison!;
  const leads = metrics.find((m) => m.key === "lead")!.comparison;

  const ok = (c: Comparison | null) => !!c && c.sufficient && c.previous > 0;
  const pct = (c: Comparison) => pctChange(c.current, c.previous)!;
  const na = (key: ScenarioFlag["key"], title: string, detail: string): ScenarioFlag => ({ key, title, status: "not_evaluated", detail });

  const flags: ScenarioFlag[] = [
    !ok(contacted) || !ok(outcomes)
      ? na("A", "More outreach, no more results", "Needs at least 10 contacts and 10 outcomes in both periods.")
      : pct(contacted) >= FLAG_PERCENT && outcomes!.change <= 0
        ? { key: "A", title: "More outreach, no more results", status: "raised", detail: `Contacts rose ${pct(contacted).toFixed(0)}% but leads, meetings, proposals and customers did not rise (${outcomes!.previous} to ${outcomes!.current}).` }
        : { key: "A", title: "More outreach, no more results", status: "clear", detail: "Outreach and results are not moving in opposite directions." },
    !ok(contacted) || !ok(outcomes)
      ? na("B", "Results up without more outreach", "Needs at least 10 contacts and 10 outcomes in both periods.")
      : pct(outcomes!) >= FLAG_PERCENT && pct(contacted) < FLAG_PERCENT
        ? { key: "B", title: "Results up without more outreach", status: "raised", detail: `Results rose ${pct(outcomes!).toFixed(0)}% while contacts did not: the growth is probably coming from somewhere other than outreach.` }
        : { key: "B", title: "Results up without more outreach", status: "clear", detail: "No growth that outreach does not explain." },
    !visits || !ok(visits.comparison) || !ok(leads)
      ? na("C", "More visitors, no more enquiries", input.bweConnected ? "Needs at least 10 visit sessions and 10 leads in both periods." : "Site visits are not connected for this workspace.")
      : pct(visits.comparison) >= FLAG_PERCENT && leads!.change <= 0
        ? { key: "C", title: "More visitors, no more enquiries", status: "raised", detail: `Visit sessions rose ${pct(visits.comparison).toFixed(0)}% but leads did not rise (${leads!.previous} to ${leads!.current}).` }
        : { key: "C", title: "More visitors, no more enquiries", status: "clear", detail: "Traffic and enquiries are not moving in opposite directions." },
  ];
  const eff = input.effectiveness;
  if (!eff || eff.current.days < MIN_SCORED_DAYS || eff.current.average === null || !ok(outcomes)) {
    flags.push(na("D", "High effectiveness scores, results down", `Needs ${MIN_SCORED_DAYS} scored days and 10 outcomes in both periods.`));
  } else if (eff.current.average >= HIGH_EFFECTIVENESS && pct(outcomes!) <= -FLAG_PERCENT) {
    flags.push({ key: "D", title: "High effectiveness scores, results down", status: "raised", detail: `Daily Effectiveness averaged ${Math.round(eff.current.average)} but results fell ${Math.abs(pct(outcomes!)).toFixed(0)}%: being productive is not producing growth.` });
  } else {
    flags.push({ key: "D", title: "High effectiveness scores, results down", status: "clear", detail: "Effectiveness scores and results are not moving in opposite directions." });
  }

  const caveats: string[] = [];
  if (!input.bweConnected) caveats.push("This workspace has no business-data connection, so leads, meetings, proposals, customers and revenue are not measured.");
  if (revenueBlock && revenueBlock.otherCurrencyPayments > 0) caveats.push(`${revenueBlock.otherCurrencyPayments} payment(s) in another currency are not included in revenue.`);
  if (metrics.some((m) => m.measured && m.comparison && !m.comparison.sufficient)) caveats.push(`Trends need at least ${min} events in both periods; smaller samples show counts only.`);
  if (input.bweConnected) caveats.push("Revenue and downstream outcomes are linked to a prospect only where a recorded link exists; the rest is shown as unknown.");

  return { asOfDate: current.to, windowDays, minEvents: min, current, previous, metrics, conversions, cohort, revenue: revenueBlock, visits, flags, caveats };
}
