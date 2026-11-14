import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Notice, PageHeader, Panel } from "@/components/ui";
import { useWorkspace } from "@/lib/use-workspace";
import { getMonthlyReport } from "@/lib/report.functions";

export const Route = createFileRoute("/_app/reports")({ component: Page });

const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

function Page() {
  const { tenant } = useWorkspace();
  const [month, setMonth] = useState<string | undefined>(undefined);
  const fetchIt = useServerFn(getMonthlyReport);
  const q = useQuery({ queryKey: ["monthly-report", tenant.slug, month ?? "latest"], queryFn: () => fetchIt({ data: { slug: tenant.slug, month } }) });
  const r = q.data;
  return (
    <>
      <PageHeader title="Reports" description="A month of recorded activity and results for this workspace. Nothing here is estimated." />
      {q.isLoading ? <p role="status" className="text-espresso-soft">Loading…</p> : null}
      {q.error ? <Notice tone="error">{q.error.message}</Notice> : null}
      {r ? (
        <div className="space-y-5">
          <label className="block text-sm">Month{" "}
            <select className="rounded border border-line bg-card px-2 py-1" value={r.month} onChange={(e) => setMonth(e.target.value)}>
              {r.months.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <Panel title="Results" emphasis="primary">
            {r.results ? (
              <ul className="grid gap-2 text-sm sm:grid-cols-3">
                <li>Leads: <b>{r.results.leads}</b></li><li>Meetings: <b>{r.results.meetings}</b></li><li>Proposals: <b>{r.results.proposals}</b></li>
                <li>Agreements: <b>{r.results.agreements}</b></li><li>New customers: <b>{r.results.customers}</b></li><li>Revenue: <b>{usd(r.results.revenueUsdCents)}</b></li>
              </ul>
            ) : <p className="text-sm text-espresso-soft">Not connected: this workspace has no link to business records, so leads, customers and revenue are not measured.</p>}
          </Panel>
          <Panel title="Outreach">
            <ul className="grid gap-2 text-sm sm:grid-cols-4">
              <li>Opportunities found: <b>{r.outreach.opportunities}</b></li><li>Prospects: <b>{r.outreach.prospects}</b></li>
              <li>Emails sent: <b>{r.outreach.emailsSent}</b></li><li>Replies: <b>{r.outreach.replies}</b></li>
            </ul>
          </Panel>
          <Panel title="Daily work and suggestions" emphasis="supporting">
            <p className="text-sm">{r.effectiveness.average === null ? "No finalized daily effectiveness scores this month." : `Daily effectiveness averaged ${r.effectiveness.average} over ${r.effectiveness.daysScored} scored days.`} Suggestions raised {r.suggestions.raised}, decided {r.suggestions.decided}, carried out {r.suggestions.carriedOut}. AI and search spend: ${r.spendUsd}.</p>
          </Panel>
        </div>
      ) : null}
    </>
  );
}
