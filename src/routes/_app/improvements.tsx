import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { EmptyState, Notice, PageHeader, Panel } from "@/components/ui";
import { useWorkspace } from "@/lib/use-workspace";
import { decideRecommendation, getRecommendations, implementRecommendation, type RecommendationView } from "@/lib/improve.functions";

export const Route = createFileRoute("/_app/improvements")({ component: Page });

const VERDICT: Record<string, string> = { improved: "Improved", worse: "Got worse", no_change: "No clear change", insufficient_evidence: "Too few events to say" };
const date = (iso: string) => iso.slice(0, 10);

function Page() {
  const { tenant } = useWorkspace();
  const qc = useQueryClient();
  const fetchIt = useServerFn(getRecommendations);
  const decide = useServerFn(decideRecommendation);
  const implement = useServerFn(implementRecommendation);
  const q = useQuery({ queryKey: ["recommendations", tenant.slug], queryFn: () => fetchIt({ data: { slug: tenant.slug } }) });
  const run = useMutation({
    mutationFn: async (a: { id: string; kind: "approve" | "reject" | "implemented" }) => (a.kind === "implemented" ? implement({ data: { slug: tenant.slug, id: a.id } }) : decide({ data: { slug: tenant.slug, id: a.id, action: a.kind } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recommendations", tenant.slug] }),
  });
  const items = q.data?.items ?? [];
  const open = items.filter((i) => i.status === "proposed" || i.status === "approved");
  const done = items.filter((i) => i.status === "implemented" || i.status === "rejected");
  const result = run.data && !run.data.ok ? run.data.reason : null;
  return (
    <>
      <PageHeader title="Improvements" description="Suggestions based on recorded results. Nothing changes until you change it yourself; mark a suggestion carried out and the results 30 days later are compared with the 30 days before." />
      {q.isLoading ? <p role="status" className="text-espresso-soft">Loading…</p> : null}
      {q.error ? <Notice tone="error">{q.error.message}</Notice> : null}
      {run.error ? <Notice tone="error">{run.error.message}</Notice> : null}
      {result ? <Notice>{result}</Notice> : null}
      <div className="space-y-5">
        <Panel title="Suggestions waiting">
          {q.data && !open.length ? <EmptyState title="No suggestions right now">A suggestion appears only when recorded results support one, for example a campaign with many emails and no replies. Until then there is nothing to suggest.</EmptyState> : null}
          <ul className="space-y-4">{open.map((r) => <Card key={r.id} r={r} canDecide={!!q.data?.canDecide} busy={run.isPending} onAct={(kind) => run.mutate({ id: r.id, kind })} />)}</ul>
        </Panel>
        {done.length ? <Panel title="Decided and measured"><ul className="space-y-4">{done.map((r) => <Card key={r.id} r={r} canDecide={false} busy={false} onAct={() => {}} />)}</ul></Panel> : null}
      </div>
    </>
  );
}

function Card({ r, canDecide, busy, onAct }: { r: RecommendationView; canDecide: boolean; busy: boolean; onAct: (k: "approve" | "reject" | "implemented") => void }) {
  return (
    <li className="rounded border border-line p-4">
      <p className="font-medium">{r.title}{r.campaignName ? <span className="text-espresso-soft"> ({r.campaignName})</span> : null}</p>
      <p className="text-sm text-espresso-soft">{r.rationale}</p>
      <ul className="mt-2 list-disc pl-5 text-sm">{r.evidence.map((e) => <li key={e.label}>{e.label}: {e.value} <span className="text-xs text-espresso-soft">({e.source})</span></li>)}</ul>
      <p className="mt-2 text-xs text-espresso-soft">
        {r.status === "proposed" ? `Suggested ${date(r.createdAt)}.` : null}
        {r.status === "approved" ? `Approved ${r.decidedAt ? date(r.decidedAt) : ""}. Make the change yourself, then mark it carried out.` : null}
        {r.status === "rejected" ? `Rejected ${r.decidedAt ? date(r.decidedAt) : ""}. It will not be suggested again for 30 days.` : null}
        {r.status === "implemented" ? `Carried out ${r.implementedAt ? date(r.implementedAt) : ""}; the measure was ${r.baseline} in the 30 days before.` : null}
      </p>
      {r.outcome ? <p className="mt-1 text-sm"><span className="font-medium">{VERDICT[r.outcome.verdict]}.</span> {r.outcome.note}</p> : null}
      {r.status === "implemented" && !r.outcome && r.outcomeDueAt ? <p className="mt-1 text-sm text-espresso-soft">Result due {date(r.outcomeDueAt)}.</p> : null}
      {canDecide && (r.status === "proposed" || r.status === "approved") ? (
        <div className="mt-3 flex gap-2">
          {r.status === "proposed" ? <button disabled={busy} className="rounded border border-line px-3 py-1 text-sm" onClick={() => onAct("approve")}>Approve</button> : null}
          {r.status === "approved" ? <button disabled={busy} className="rounded border border-line px-3 py-1 text-sm" onClick={() => onAct("implemented")}>I carried this out</button> : null}
          <button disabled={busy} className="rounded border border-line px-3 py-1 text-sm" onClick={() => onAct("reject")}>Reject</button>
        </div>
      ) : null}
    </li>
  );
}
