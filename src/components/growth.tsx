import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { EmptyState, Notice } from "@/components/ui";
import { useWorkspace } from "@/lib/use-workspace";
import { getGrowth } from "@/lib/growth.functions";
import type { Comparison, GrowthReport, MetricRow, ScenarioFlag } from "@/lib/growth/metrics";

function useGrowth() {
  const { tenant } = useWorkspace();
  const fetchIt = useServerFn(getGrowth);
  return useQuery({ queryKey: ["growth", tenant.slug], queryFn: () => fetchIt({ data: { slug: tenant.slug } }) });
}

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const value = (m: Pick<MetricRow, "unit">, n: number) => (m.unit === "usd_cents" ? usd(n) : String(n));
const arrow = { up: "Up", down: "Down", flat: "Flat", insufficient: "Insufficient evidence" } as const;

function Trend({ c }: { c: Comparison }) {
  if (c.percent !== null) return <span>{arrow[c.trend]} {c.percent > 0 ? "+" : ""}{c.percent}%</span>;
  return <span className="text-espresso-soft">{c.note ?? arrow[c.trend]}</span>;
}

function MetricCard({ m }: { m: MetricRow }) {
  if (!m.measured || !m.comparison) {
    return (
      <li className="rounded border border-line p-3">
        <p className="text-sm font-medium">{m.label}</p>
        <p className="text-sm text-espresso-soft">Not connected for this workspace.</p>
      </li>
    );
  }
  const c = m.comparison;
  const max = Math.max(c.current, c.previous, 1);
  return (
    <li className="rounded border border-line p-3">
      <p className="text-sm font-medium">{m.label}</p>
      <p className="text-2xl font-semibold">{value(m, c.current)}</p>
      <p className="text-sm"><Trend c={c} /></p>
      <div className="mt-2 space-y-1 text-xs text-espresso-soft" aria-label={`${m.label}: ${value(m, c.current)} now, ${value(m, c.previous)} before`}>
        <div className="flex items-center gap-2"><span className="w-14">Last 30</span><div className="h-2 rounded bg-terracotta" style={{ width: `${(c.current / max) * 60}%` }} /><span>{value(m, c.current)}</span></div>
        <div className="flex items-center gap-2"><span className="w-14">Before</span><div className="h-2 rounded bg-line" style={{ width: `${(c.previous / max) * 60}%` }} /><span>{value(m, c.previous)}</span></div>
      </div>
    </li>
  );
}

const HEADLINE = ["lead", "meeting", "proposal", "customer", "revenue"] as const;

/** The primary panel on the Daily Action Center. */
export function GrowthSummary() {
  const q = useGrowth();
  if (q.isLoading) return <p role="status" className="text-espresso-soft">Loading…</p>;
  if (q.error) return <Notice tone="error">{q.error.message}</Notice>;
  if (!q.data) return null;
  const r = q.data.report;
  const any = r.metrics.some((m) => m.measured && m.comparison && (m.comparison.current > 0 || m.comparison.previous > 0));
  if (!any) {
    return (
      <EmptyState title="No growth data yet">
        Nothing has been recorded for {r.current.from} to {r.current.to} or the 30 days before. Outcomes appear as outreach is sent and leads, meetings, proposals and payments are recorded.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-espresso-soft">{r.current.from} to {r.current.to}, compared with {r.previous.from} to {r.previous.to}.</p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{r.metrics.filter((m) => (HEADLINE as readonly string[]).includes(m.key)).map((m) => <MetricCard key={m.key} m={m} />)}</ul>
      <Flags flags={r.flags} compact />
      {r.caveats[0] ? <p className="text-xs text-espresso-soft">{r.caveats[0]}</p> : null}
    </div>
  );
}

function Flags({ flags, compact = false }: { flags: ScenarioFlag[]; compact?: boolean }) {
  const shown = compact ? flags.filter((f) => f.status === "raised") : flags;
  if (!shown.length) return null;
  return (
    <ul className="space-y-1 text-sm">
      {shown.map((f) => (
        <li key={f.key}><span className="font-medium">{f.status === "raised" ? "Watch: " : f.status === "clear" ? "Clear: " : "Not evaluated: "}{f.title}.</span> <span className="text-espresso-soft">{f.detail}</span></li>
      ))}
    </ul>
  );
}

function pct(n: number | null) {
  return n === null ? "n/a" : `${n}%`;
}

export function GrowthDetail() {
  const q = useGrowth();
  if (q.isLoading) return <p role="status" className="text-espresso-soft">Loading…</p>;
  if (q.error) return <Notice tone="error">{q.error.message}</Notice>;
  if (!q.data) return null;
  const r: GrowthReport = q.data.report;
  return (
    <div className="space-y-6">
      <p className="text-sm text-espresso-soft">Last {r.windowDays} days ({r.current.from} to {r.current.to}) against the {r.windowDays} days before. Trends need at least {r.minEvents} events in both periods; below that only counts are shown. This is separate from the opportunity scores and the daily effectiveness score.</p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{r.metrics.map((m) => <MetricCard key={m.key} m={m} />)}</ul>
      {r.visits ? (
        <section>
          <h3 className="font-medium">Site visits</h3>
          <p className="text-sm">{r.visits.current} recorded visits, against {r.visits.previous}. <Trend c={r.visits.comparison} /></p>
        </section>
      ) : null}
      {r.revenue ? (
        <section>
          <h3 className="font-medium">Revenue and where it came from</h3>
          <ul className="text-sm">
            <li>Paid in the last {r.windowDays} days: {usd(r.revenue.totalCents.current)} (before: {usd(r.revenue.totalCents.previous)})</li>
            <li>Linked to a prospect: {usd(r.revenue.attributedCents.current)}, of which a direct id link: {usd(r.revenue.highConfidenceCents.current)}</li>
            <li>Not linked to any prospect (unknown): {usd(r.revenue.unattributedCents.current)}</li>
          </ul>
        </section>
      ) : null}
      <section>
        <h3 className="font-medium">Conversion between stages</h3>
        <p className="text-xs text-espresso-soft">Events in the window divided by events in the window: not the same people. See the cohort view for that.</p>
        <ul className="mt-1 divide-y divide-line text-sm">
          {r.conversions.map((c) => (
            <li key={c.label} className="flex justify-between py-1"><span>{c.label}</span><span className="text-espresso-soft">{pct(c.current.rate)} ({c.current.numerator} of {c.current.denominator}), before {pct(c.previous.rate)}</span></li>
          ))}
        </ul>
      </section>
      {r.cohort ? (
        <section>
          <h3 className="font-medium">Prospects first pursued in the last {r.windowDays} days</h3>
          {r.cohort.size === 0 ? <p className="text-sm text-espresso-soft">None were pursued in this period.</p> : (
            <p className="text-sm">{r.cohort.size} prospects: {r.cohort.contacted} contacted, {r.cohort.replied} replied, {r.cohort.leads} became leads, {r.cohort.customers} became customers{r.revenue ? ` (${usd(r.cohort.revenueCents)} paid)` : ""}.{r.cohort.sufficient ? "" : ` Fewer than ${r.minEvents}, so too few to read a rate from.`}</p>
          )}
        </section>
      ) : null}
      <section>
        <h3 className="font-medium">What the numbers suggest</h3>
        <Flags flags={r.flags} />
      </section>
      {r.caveats.length ? <ul className="list-disc pl-5 text-xs text-espresso-soft">{r.caveats.map((c) => <li key={c}>{c}</li>)}</ul> : null}
      {q.data.snapshots.length ? <p className="text-xs text-espresso-soft">Frozen daily reports kept: {q.data.snapshots.length}, latest {q.data.snapshots[0]!.asOfDate}. They are never rewritten.</p> : null}
    </div>
  );
}
