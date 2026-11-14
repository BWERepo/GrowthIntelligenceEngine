import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Notice, PageHeader, Panel } from "@/components/ui";
import { useWorkspace } from "@/lib/use-workspace";
import { createClientWorkspace, getWorkspaces, setWorkspaceQuotas, setWorkspaceStatus } from "@/lib/agency.functions";

export const Route = createFileRoute("/_app/workspaces")({ component: Page });

function Page() {
  const { isPlatformAdmin } = useWorkspace();
  if (!isPlatformAdmin) return (<><PageHeader title="Workspaces" /><Notice>Only platform administrators can see this page.</Notice></>);
  return <Admin />;
}

function Admin() {
  const qc = useQueryClient();
  const list = useServerFn(getWorkspaces);
  const create = useServerFn(createClientWorkspace);
  const status = useServerFn(setWorkspaceStatus);
  const quotas = useServerFn(setWorkspaceQuotas);
  const q = useQuery({ queryKey: ["workspaces"], queryFn: () => list() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["workspaces"] });
  const st = useMutation({ mutationFn: (a: { tenantId: string; status: "active" | "suspended" }) => status({ data: a }), onSuccess: refresh });
  const qu = useMutation({ mutationFn: (a: { tenantId: string; quotas: { maxActiveCampaigns: number; maxMembers: number; dailySendCap: number | null } }) => quotas({ data: a }), onSuccess: refresh });
  const [form, setForm] = useState({ name: "", slug: "", timezone: "America/New_York", ownerEmail: "", monthlyBudgetUsd: 20 });
  const cr = useMutation({ mutationFn: () => create({ data: form }), onSuccess: (r) => { if (r.ok) { setForm({ ...form, name: "", slug: "", ownerEmail: "" }); refresh(); } } });
  return (
    <>
      <PageHeader title="Workspaces" description="Every client workspace, its limits and whether anything needs attention. Platform administrators only." />
      {q.error ? <Notice tone="error">{q.error.message}</Notice> : null}
      <div className="space-y-5">
        <Panel title="Workspaces" emphasis="primary">
          <ul className="space-y-4">
            {q.data?.map((w) => (
              <li key={w.id} className="rounded border border-line p-4 text-sm">
                <p className="font-medium">{w.name} <span className="text-espresso-soft">({w.slug}, {w.status})</span></p>
                <p>{w.members} of {w.quotas.maxMembers} members, {w.activeCampaigns} of {w.quotas.maxActiveCampaigns} active campaigns, {w.sentLast24h} of {w.sendCapNow} emails in 24 hours.</p>
                <p>{w.budget ? `Monthly budget: $${w.budget.spentUsd.toFixed(2)} of $${w.budget.limitUsd} (${w.budget.state}).` : "No monthly budget set."} Failed jobs in 7 days: {w.failedJobs7d}. {w.lastJob ? `Last job: ${w.lastJob.kind} ${w.lastJob.status}.` : "No jobs yet."}</p>
                {w.attention.length ? <ul className="mt-1 list-disc pl-5 text-terracotta">{w.attention.map((a) => <li key={a}>{a}</li>)}</ul> : null}
                {w.slug !== "bwe" ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button className="rounded border border-line px-3 py-1" disabled={st.isPending} onClick={() => st.mutate({ tenantId: w.id, status: w.status === "active" ? "suspended" : "active" })}>{w.status === "active" ? "Suspend" : "Reactivate"}</button>
                    <button className="rounded border border-line px-3 py-1" disabled={qu.isPending} onClick={() => {
                      const n = (label: string, cur: number) => Number(window.prompt(label, String(cur)));
                      const c = n("Active campaigns allowed", w.quotas.maxActiveCampaigns), m = n("Team members allowed", w.quotas.maxMembers);
                      const d = window.prompt("Emails per day (blank for the app-wide limit)", w.quotas.dailySendCap === null ? "" : String(w.quotas.dailySendCap));
                      if (Number.isFinite(c) && Number.isFinite(m) && d !== null) qu.mutate({ tenantId: w.id, quotas: { maxActiveCampaigns: c, maxMembers: m, dailySendCap: d.trim() === "" ? null : Number(d) } });
                    }}>Change limits</button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {st.error ? <Notice tone="error">{st.error.message}</Notice> : null}
          {qu.error ? <Notice tone="error">{qu.error.message}</Notice> : null}
        </Panel>
        <Panel title="Create a client workspace">
          <p className="mb-2 text-sm text-espresso-soft">The owner needs an account already. Clients cannot send email until a mailbox is set up for them; approval stays blocked until then.</p>
          <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); cr.mutate(); }}>
            {(["name", "slug", "timezone", "ownerEmail"] as const).map((k) => (
              <label key={k} className="text-sm">{k}<input required className="mt-1 block w-full rounded border border-line bg-card px-2 py-1" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>
            ))}
            <label className="text-sm">monthly budget (USD)<input type="number" min={1} max={500} className="mt-1 block w-full rounded border border-line bg-card px-2 py-1" value={form.monthlyBudgetUsd} onChange={(e) => setForm({ ...form, monthlyBudgetUsd: Number(e.target.value) })} /></label>
            <div className="sm:col-span-2"><button className="rounded border border-line px-3 py-1" disabled={cr.isPending}>Create workspace</button></div>
          </form>
          {cr.error ? <Notice tone="error">{cr.error.message}</Notice> : null}
          {cr.data && !cr.data.ok ? <Notice>{cr.data.reason}</Notice> : null}
        </Panel>
      </div>
    </>
  );
}
