import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Notice } from "@/components/ui";
import { useWorkspace } from "@/lib/use-workspace";
import { getEffectiveness, type EffectivenessView } from "@/lib/effectiveness.functions";

function useEffectiveness(date?: string) {
  const { tenant } = useWorkspace();
  const fetchIt = useServerFn(getEffectiveness);
  return useQuery({ queryKey: ["effectiveness", tenant.slug, date ?? "today"], queryFn: () => fetchIt({ data: { slug: tenant.slug, date } }) });
}

const stateNote = (v: EffectivenessView) =>
  v.state === "stored" ? `Final, rules ${v.ruleVersion}. It is never rewritten.` : v.state === "provisional" ? `Provisional: it changes as the day's activity is recorded, and becomes final when the end-of-day review is finalized. Rules ${v.ruleVersion}.` : "";

function Headline({ v }: { v: EffectivenessView }) {
  if (!v.available) {
    return (
      <div>
        <p className="font-medium">Score unavailable</p>
        <p className="text-sm text-espresso-soft">{v.reason ?? "Insufficient verified activity data."}</p>
        {v.state !== "none" ? <p className="mt-1 text-sm text-espresso-soft">Measurable so far: {v.completeness}% of the score.</p> : null}
      </div>
    );
  }
  return (
    <div>
      <p><span className="text-3xl font-semibold">{v.score}</span><span className="text-espresso-soft"> / 100</span> <span className="ml-2 text-sm">{v.band}</span></p>
      <p className="text-sm text-espresso-soft">Based on {v.completeness}% of the score that could be measured. Bands are operational heuristics, not industry standards.</p>
    </div>
  );
}

/** The small supporting panel on the Daily Action Center. */
export function EffectivenessSummary() {
  const q = useEffectiveness();
  if (q.isLoading) return <p role="status" className="text-espresso-soft">Loading…</p>;
  if (q.error) return <Notice tone="error">{q.error.message}</Notice>;
  if (!q.data) return null;
  return (
    <div className="space-y-1">
      <Headline v={q.data} />
      <p className="text-xs text-espresso-soft">{stateNote(q.data)} How meaningful today's work was. Separate from the opportunity scores and from 30-day growth.</p>
    </div>
  );
}

/** Components, what earned the points, and recent history, for the review screen. */
export function EffectivenessDetail({ date }: { date: string }) {
  const q = useEffectiveness(date);
  if (q.isLoading) return <p role="status" className="text-espresso-soft">Loading…</p>;
  if (q.error) return <Notice tone="error">{q.error.message}</Notice>;
  const v = q.data;
  if (!v) return null;
  return (
    <div className="space-y-4">
      <Headline v={v} />
      <p className="text-xs text-espresso-soft">{stateNote(v)}</p>
      {v.components.length ? (
        <ul className="space-y-3">
          {v.components.map((c) => (
            <li key={c.key}>
              <div className="flex justify-between text-sm"><span className="font-medium">{c.label}</span><span>{c.measured ? `${c.points} of ${c.weight}` : "not measured"}</span></div>
              <div className="mt-1 h-2 rounded bg-parchment" aria-hidden="true"><div className="h-2 rounded bg-terracotta" style={{ width: `${c.measured && c.points !== null ? Math.round((c.points / c.weight) * 100) : 0}%` }} /></div>
              <p className="mt-1 text-xs text-espresso-soft">{c.explanation}{c.earnedBy.length ? ` Earned by ${c.earnedBy.length} recorded event${c.earnedBy.length === 1 ? "" : "s"}.` : ""}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {v.history.length ? (
        <div>
          <p className="text-sm font-medium">Recent days</p>
          <ul className="mt-1 divide-y divide-line text-sm">
            {v.history.map((h) => (
              <li key={h.localDate} className="flex justify-between py-1"><span>{h.localDate}</span><span className="text-espresso-soft">{h.available ? `${h.score} · ${h.band}` : `unavailable (${h.completeness}% measurable)`}</span></li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
