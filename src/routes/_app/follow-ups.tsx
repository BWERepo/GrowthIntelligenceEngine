import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { completeFollowUp, getFollowUps } from "@/lib/actions.functions";
import { useWorkspace } from "@/lib/use-workspace";
import { EmptyState, Notice, PageHeader } from "@/components/ui";

export const Route = createFileRoute("/_app/follow-ups")({ component: Page });

function Page() {
  const { tenant } = useWorkspace();
  const qc = useQueryClient();
  const list = useServerFn(getFollowUps);
  const done = useServerFn(completeFollowUp);
  const q = useQuery({ queryKey: ["follow-ups", tenant.slug], queryFn: () => list({ data: { slug: tenant.slug } }) });
  const m = useMutation({
    mutationFn: (id: string) => done({ data: { slug: tenant.slug, followUpId: id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["follow-ups", tenant.slug] }),
  });
  return (
    <>
      <PageHeader title="Follow-Ups" description="Who is waiting on you. Due follow-ups are ranked first in each morning's package." />
      {q.isLoading ? <p role="status" className="text-espresso-soft">Loading…</p> : null}
      {q.error ? <Notice tone="error">{q.error.message}</Notice> : null}
      {q.data && q.data.items.length === 0 ? <EmptyState title="No open follow-ups">Follow-ups appear here once one is scheduled for a prospect.</EmptyState> : null}
      <ul className="space-y-3">
        {q.data?.items.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-card p-4">
            <div>
              <p className="font-medium">{f.businessName}</p>
              <p className="text-sm text-espresso-soft">Due {f.dueDate}{f.overdue ? " (overdue)" : ""}{f.note ? ` · ${f.note}` : ""}</p>
            </div>
            {q.data.canAct ? <button className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-50" disabled={m.isPending} onClick={() => m.mutate(f.id)}>Mark done</button> : null}
          </li>
        ))}
      </ul>
      {m.error ? <div className="mt-3"><Notice tone="error">{m.error.message}</Notice></div> : null}
    </>
  );
}
