import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { EmptyState, Notice, PageHeader, Panel } from "@/components/ui";
import { EffectivenessDetail } from "@/components/effectiveness";
import { useWorkspace } from "@/lib/use-workspace";
import { buildReviewNow, finalizeReviewFn, getReview, saveReviewItem, type ReviewItemView, type ReviewView } from "@/lib/review.functions";
import { allowedDispositions, DISPOSITION_LABEL, isSettled, needsDate, recommendDisposition, type Disposition, type ItemStatus } from "@/lib/review/rules";

export const Route = createFileRoute("/_app/review")({ component: Page });

const STATUS_LABEL: Record<ItemStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
  deferred: "Deferred",
  blocked: "Blocked",
  awaiting_response: "Awaiting response",
  cancelled: "Cancelled",
};

type Draft = { corrected: ItemStatus | null; disposition: Disposition | null; date: string | null; note: string };

const addDays = (isoDate: string, n: number) => new Date(Date.parse(`${isoDate}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function Page() {
  const { tenant } = useWorkspace();
  const qc = useQueryClient();
  const [date, setDate] = useState<string | undefined>(undefined);
  const fetchReview = useServerFn(getReview);
  const q = useQuery({ queryKey: ["review", tenant.slug, date ?? "today"], queryFn: () => fetchReview({ data: { slug: tenant.slug, date } }) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["review", tenant.slug] }), qc.invalidateQueries({ queryKey: ["effectiveness", tenant.slug] })]);
  const build = useServerFn(buildReviewNow);
  const buildM = useMutation({ mutationFn: () => build({ data: { slug: tenant.slug } }), onSuccess: refresh });
  const v = q.data;

  return (
    <>
      <PageHeader title="End-of-Day Review" description="What got done today, what to correct, and what happens to everything left over." />
      {q.isLoading ? <p role="status" className="text-espresso-soft">Loading…</p> : null}
      {q.error ? <Notice tone="error">{q.error.message}</Notice> : null}
      {v ? (
        <div className="space-y-5">
          {v.dates.length > 0 ? (
            <label className="block text-sm">
              Day{" "}
              <select className="rounded-lg border border-line bg-card px-3 py-1.5" value={v.localDate} onChange={(e) => setDate(e.target.value === v.today ? undefined : e.target.value)}>
                {[...new Set([v.today, ...v.dates])].map((d) => <option key={d} value={d}>{d}{d === v.today ? " (today)" : ""}</option>)}
              </select>
            </label>
          ) : null}
          {!v.review ? (
            <EmptyState title={`No review for ${v.localDate}`}>
              The review is prepared each business day at the evening time from that day's action package. Non-business days have none.
              {tenant.role === "owner" && v.localDate === v.today ? (
                <div className="mt-3">
                  <button className="rounded-lg bg-terracotta px-4 py-2 text-white disabled:opacity-50" disabled={buildM.isPending} onClick={() => buildM.mutate()}>{buildM.isPending ? "Building…" : "Build today's review now"}</button>
                  {buildM.error ? <div className="mt-2"><Notice tone="error">{buildM.error.message}</Notice></div> : null}
                </div>
              ) : null}
            </EmptyState>
          ) : (
            <ReviewBody v={v} onChanged={refresh} />
          )}
          <Panel kicker="Separate measurement" title={`Daily Effectiveness, ${v.localDate}`}>
            <EffectivenessDetail date={v.localDate} />
          </Panel>
        </div>
      ) : null}
    </>
  );
}

function ReviewBody({ v, onChanged }: { v: ReviewView; onChanged: () => void }) {
  const { tenant } = useWorkspace();
  const review = v.review!;
  const locked = review.status === "finalized";
  const save = useServerFn(saveReviewItem);
  const finalize = useServerFn(finalizeReviewFn);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  useEffect(() => {
    // Start from what is saved; where nothing is saved yet, from the recommendation.
    const next: Record<string, Draft> = {};
    for (const it of v.items) {
      const status = it.correctedStatus ?? it.recordedStatus;
      const rec = recommendDisposition({ kind: it.kind, status, timesUnfinishedBefore: it.timesUnfinished });
      next[it.id] = {
        corrected: it.correctedStatus,
        disposition: it.disposition ?? rec.disposition,
        date: it.dispositionDate ?? (rec.suggestDays ? addDays(v.today, rec.suggestDays) : null),
        note: it.note ?? "",
      };
    }
    setDrafts(next);
  }, [review.id, v.items]);

  const problems = useMutation({
    mutationFn: async () => {
      await Promise.all(v.items.map((it) => {
        const d = drafts[it.id];
        if (!d) return Promise.resolve();
        const status = d.corrected ?? it.recordedStatus;
        return save({ data: { slug: tenant.slug, reviewItemId: it.id, correctedStatus: d.corrected, disposition: isSettled(status) ? "none" : d.disposition, dispositionDate: d.date, note: d.note.trim() || null } });
      }));
      return finalize({ data: { slug: tenant.slug, date: v.localDate } });
    },
    onSuccess: onChanged,
  });
  const result = problems.data && !problems.data.ok ? problems.data : null;
  const problemBy = new Map((result?.problems ?? []).map((p) => [p.itemId, p.message]));

  return (
    <>
      <Panel kicker={locked ? "Finalized" : "Draft"} title={`Plan versus actual, ${v.localDate}`}>
        {review.late ? <p className="mb-2 text-sm text-espresso-soft">Built late, after the usual evening time.</p> : null}
        {!review.hasPackage ? <p className="mb-2 text-sm text-espresso-soft">No action package was built for this day, so nothing was planned.</p> : null}
        {v.items.length === 0 && review.hasPackage ? <p className="text-espresso-soft">The package had no items.</p> : null}
        <ul className="space-y-4">
          {v.items.map((it) => (
            <ItemRow key={it.id} it={it} draft={drafts[it.id]} today={v.today} locked={locked || !v.canCorrect} problem={problemBy.get(it.itemId)} onChange={(d) => setDrafts((all) => ({ ...all, [it.id]: d }))} />
          ))}
        </ul>
        {!locked && v.canFinalize ? (
          <div className="mt-5">
            <button className="rounded-lg bg-terracotta px-4 py-2 text-white disabled:opacity-50" disabled={problems.isPending} onClick={() => { if (window.confirm("Finalize this review? It applies your decisions and cannot be changed afterwards.")) problems.mutate(); }}>{problems.isPending ? "Finalizing…" : "Finalize the review"}</button>
            <p className="mt-1 text-xs text-espresso-soft">Applies your decisions, stores a provisional plan for the next business day, and locks this review.</p>
            {result ? <div className="mt-2"><Notice tone="error">{result.reason}</Notice></div> : null}
            {problems.error ? <div className="mt-2"><Notice tone="error">{problems.error.message}</Notice></div> : null}
          </div>
        ) : null}
        {!locked && !v.canFinalize ? <p className="mt-4 text-sm text-espresso-soft">Only the workspace owner can finalize.</p> : null}
      </Panel>

      {locked ? (
        <>
          <Panel kicker="Written from the record" title="Note on the day">
            {v.assessment ? (
              <div className="space-y-2">
                <p>{v.assessment.summary}</p>
                {v.assessment.wentWell.length ? <div><p className="text-sm font-medium">Went well</p><ul className="list-disc pl-5 text-sm">{v.assessment.wentWell.map((t) => <li key={t}>{t}</li>)}</ul></div> : null}
                {v.assessment.needsAttention.length ? <div><p className="text-sm font-medium">Needs attention</p><ul className="list-disc pl-5 text-sm">{v.assessment.needsAttention.map((t) => <li key={t}>{t}</li>)}</ul></div> : null}
                {v.assessment.suggestion ? <p className="text-sm"><span className="font-medium">For tomorrow:</span> {v.assessment.suggestion}</p> : null}
                <p className="text-xs text-espresso-soft">Written by {v.assessment.model} from the recorded facts only. It is a summary, not a score.</p>
              </div>
            ) : (
              <p className="text-espresso-soft">Not written yet. It is prepared within about 15 minutes of finalizing, from the recorded facts, and nothing is invented if the record is thin.</p>
            )}
          </Panel>
          <Panel kicker="Provisional" title={`Plan for ${review.tomorrowDate ?? "the next business day"}`}>
            {review.tomorrowPlan && review.tomorrowPlan.length ? (
              <ol className="list-decimal space-y-1 pl-5">{review.tomorrowPlan.map((p, i) => <li key={i}>{p.recommendedAction}</li>)}</ol>
            ) : (
              <p className="text-espresso-soft">Nothing qualifies yet. The morning package rebuilds this from fresh data at the morning time.</p>
            )}
            <p className="mt-2 text-xs text-espresso-soft">The morning package rebuilds this from fresh data, so it may differ.</p>
          </Panel>
        </>
      ) : null}
    </>
  );
}

function ItemRow({ it, draft, today, locked, problem, onChange }: { it: ReviewItemView; draft: Draft | undefined; today: string; locked: boolean; problem?: string; onChange: (d: Draft) => void }) {
  if (!draft) return null;
  const status = draft.corrected ?? it.recordedStatus;
  const facts = { kind: it.kind, status, timesUnfinishedBefore: it.timesUnfinished };
  const allowed = allowedDispositions(facts);
  const rec = recommendDisposition(facts);
  const disposition = allowed.includes(draft.disposition ?? "none") ? draft.disposition : rec.disposition;
  const field = "rounded-lg border border-line bg-card px-3 py-1.5 text-sm disabled:opacity-70";
  return (
    <li className="rounded-xl border border-line p-4">
      <p className="font-medium">{it.rank}. {it.businessName}{rec.stale ? <span className="ml-2 rounded bg-parchment px-2 py-0.5 text-xs">Stale: left unfinished {it.timesUnfinished + 1} times</span> : null}</p>
      <p className="text-sm text-espresso-soft">{it.recommendedAction}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">Recorded: {STATUS_LABEL[it.recordedStatus]}. What actually happened?
          <select className={`${field} mt-1 block w-full`} disabled={locked} value={draft.corrected ?? it.recordedStatus} onChange={(e) => onChange({ ...draft, corrected: e.target.value === it.recordedStatus ? null : (e.target.value as ItemStatus) })}>
            {(Object.keys(STATUS_LABEL) as ItemStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="block text-sm">Decision
          <select className={`${field} mt-1 block w-full`} disabled={locked || allowed.length === 1} value={disposition ?? "none"} onChange={(e) => onChange({ ...draft, disposition: e.target.value as Disposition })}>
            {allowed.map((d) => <option key={d} value={d}>{DISPOSITION_LABEL[d]}{d === rec.disposition && d !== "none" ? " (recommended)" : ""}</option>)}
          </select>
        </label>
        {disposition && needsDate(disposition) ? (
          <label className="block text-sm">{disposition === "block" ? "Blocked until" : "Reschedule to"}
            <input type="date" className={`${field} mt-1 block w-full`} min={addDays(today, 1)} disabled={locked} value={draft.date ?? ""} onChange={(e) => onChange({ ...draft, date: e.target.value || null })} />
          </label>
        ) : null}
        {disposition === "dismiss" || draft.note ? (
          <label className="block text-sm">{disposition === "dismiss" ? "Reason for dismissing" : "Note"}
            <input className={`${field} mt-1 block w-full`} maxLength={300} disabled={locked} value={draft.note} onChange={(e) => onChange({ ...draft, note: e.target.value })} />
          </label>
        ) : null}
      </div>
      {problem ? <p className="mt-2 text-sm text-destructive">{problem}</p> : null}
    </li>
  );
}
