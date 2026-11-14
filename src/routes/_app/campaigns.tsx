import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCampaignsPage, runSearchNow, saveCampaign, type Campaign, type CampaignFields } from "@/lib/discovery.functions";
import { useWorkspace } from "@/lib/use-workspace";
import { EmptyState, Notice, PageHeader, Panel } from "@/components/ui";

export const Route = createFileRoute("/_app/campaigns")({ component: Page });

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const STATUS_LABEL: Record<string, string> = { draft: "Draft (not searching)", active: "Active", paused: "Paused", archived: "Archived" };

const EMPTY: CampaignFields = {
  name: "",
  status: "draft",
  industries: [],
  locations: [],
  buyingIntentQueries: [],
  prospectingQueries: [],
  maxAgeDays: 60,
  dailySearchLimit: 20,
  dailyCandidateLimit: 40,
};

function Page() {
  const { tenant } = useWorkspace();
  const fetchPage = useServerFn(getCampaignsPage);
  const q = useQuery({ queryKey: ["campaigns", tenant.slug], queryFn: () => fetchPage({ data: { slug: tenant.slug } }) });
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader title="Campaigns" description="Who to look for, where, and with what limits. Searches run overnight; each found page is read, classified and scored." />
      {q.isLoading ? <p role="status" className="text-espresso-soft">Loading…</p> : null}
      {q.error ? <Notice tone="error">{q.error.message}</Notice> : null}
      {q.data ? (
        <div className="space-y-5">
          {q.data.providers ? <DiscoveryStatus data={q.data} /> : null}
          {q.data.campaigns.length === 0 && !creating ? (
            <EmptyState title="No campaigns yet">Create a campaign to start discovery. Nothing is searched until a campaign is set to Active.</EmptyState>
          ) : null}
          {q.data.campaigns.map((c) => (
            <CampaignEditor key={c.id} campaign={c} canEdit={q.data.canEdit} />
          ))}
          {creating ? <CampaignEditor campaign={null} canEdit onDone={() => setCreating(false)} /> : null}
          {q.data.canEdit && !creating ? (
            <button className="rounded-lg border border-line px-4 py-2" onClick={() => setCreating(true)}>New campaign</button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function DiscoveryStatus({ data }: { data: NonNullable<Awaited<ReturnType<typeof getCampaignsPage>>> }) {
  const { tenant } = useWorkspace();
  const qc = useQueryClient();
  const search = useServerFn(runSearchNow);
  const run = useMutation({
    mutationFn: () => search({ data: { slug: tenant.slug } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["campaigns", tenant.slug] }),
  });
  const p = data.providers!;
  const missing = [!p.search && "BRAVE_SEARCH_API_KEY", !p.ai && "ANTHROPIC_API_KEY"].filter(Boolean) as string[];
  const month = data.budgets.find((b) => b.category === "total" && b.period === "month");
  return (
    <Panel title="Discovery status" emphasis="supporting">
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <p className="text-sm text-espresso-soft">Connections</p>
          <ul className="mt-1 text-sm">
            <li>Web search (Brave): {p.search ? "connected" : "no key"}</li>
            <li>AI classification ({p.model}): {p.ai ? "connected" : "no key"}</li>
            <li>PageSpeed: {p.pagespeed ? "connected" : "no key (optional)"}</li>
          </ul>
        </div>
        <div>
          <p className="text-sm text-espresso-soft">Spending this month</p>
          {month ? (
            <p className="mt-1">
              <strong>{money.format(month.spentUsd)}</strong> of {money.format(month.limitUsd)}
              {month.state === "exceeded" ? <span className="text-destructive"> · cap reached, discovery paused</span> : month.state === "alert" ? <span className="text-terracotta"> · past {Math.round(month.fraction * 100)}%</span> : null}
            </p>
          ) : (
            <p className="mt-1 text-sm">No monthly cap set, so paid work stays off.</p>
          )}
        </div>
        <div>
          <p className="text-sm text-espresso-soft">Queue</p>
          {data.queue ? (
            <p className="mt-1 text-sm">
              {data.queue.pending ?? 0} waiting · {data.queue.classified ?? 0} classified · {data.queue.rejected ?? 0} rejected · {data.queue.duplicate ?? 0} duplicates · {(data.queue.blocked ?? 0) + (data.queue.failed ?? 0)} blocked or failed
            </p>
          ) : null}
        </div>
      </div>
      {missing.length ? <div className="mt-3"><Notice>Discovery is off until these Worker secrets are set: {missing.join(", ")}.</Notice></div> : null}
      <div className="mt-3 text-sm">
        <p className="text-espresso-soft">Recent overnight searches</p>
        {data.lastRuns.length ? (
          <ul className="mt-1">
            {data.lastRuns.map((r) => (
              <li key={r.localDate}>{r.localDate}: {r.status}{r.error ? ` (${r.error})` : ""}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1">None yet. The first runs between 2 and 6 AM after a campaign is active.</p>
        )}
      </div>
      {data.canRunSearch && p.search ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Searching…" : "Run today's search now"}
          </button>
          <span className="text-xs text-espresso-soft">Counts as today's search. Pages found are classified in the background over the next hour.</span>
        </div>
      ) : null}
      {run.data ? <p className="mt-2 text-sm" role="status">{run.data.status === "ran" ? `${run.data.queries} searches, ${run.data.newCandidates} new pages queued.${run.data.reason ? ` ${run.data.reason}` : ""}` : `Not run: ${run.data.reason}.`}</p> : null}
      {run.error ? <div className="mt-2"><Notice tone="error">{run.error.message}</Notice></div> : null}
    </Panel>
  );
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

function CampaignEditor({ campaign, canEdit, onDone }: { campaign: Campaign | null; canEdit: boolean; onDone?: () => void }) {
  const { tenant } = useWorkspace();
  const qc = useQueryClient();
  const save = useServerFn(saveCampaign);
  const initial = campaign ?? { ...EMPTY, id: "", updatedAt: "" };
  const [f, setF] = useState({
    ...initial,
    industriesText: initial.industries.join("\n"),
    locationsText: initial.locations.join("\n"),
    intentText: initial.buyingIntentQueries.join("\n"),
    prospectText: initial.prospectingQueries.join("\n"),
  });
  const m = useMutation({
    mutationFn: () =>
      save({
        data: {
          slug: tenant.slug,
          id: campaign?.id ?? null,
          fields: {
            name: f.name,
            status: f.status,
            industries: lines(f.industriesText),
            locations: lines(f.locationsText),
            buyingIntentQueries: lines(f.intentText),
            prospectingQueries: lines(f.prospectText),
            maxAgeDays: Number(f.maxAgeDays),
            dailySearchLimit: Number(f.dailySearchLimit),
            dailyCandidateLimit: Number(f.dailyCandidateLimit),
          },
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["campaigns", tenant.slug] });
      onDone?.();
    },
  });
  const disabled = !canEdit || m.isPending;
  const input = "w-full rounded-lg border border-line bg-card px-3 py-2 disabled:opacity-70";
  const id = campaign?.id ?? "new";

  return (
    <Panel title={campaign ? campaign.name : "New campaign"} kicker={STATUS_LABEL[f.status]}>
      <form
        className="grid gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <label className="block">
          <span className="text-sm text-espresso-soft">Name</span>
          <input className={input} value={f.name} disabled={disabled} required maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-espresso-soft">Status</span>
          <select className={input} value={f.status} disabled={disabled} onChange={(e) => setF({ ...f, status: e.target.value as CampaignFields["status"] })}>
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-espresso-soft">Industries (one per line)</span>
          <textarea className={input} rows={5} value={f.industriesText} disabled={disabled} onChange={(e) => setF({ ...f, industriesText: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-espresso-soft">Locations (one per line, e.g. "Knoxville, TN")</span>
          <textarea className={input} rows={5} value={f.locationsText} disabled={disabled} onChange={(e) => setF({ ...f, locationsText: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-espresso-soft">Buying-intent searches (one per line; {"{location}"} is replaced by each location)</span>
          <textarea className={`${input} font-mono text-sm`} rows={5} value={f.intentText} disabled={disabled} onChange={(e) => setF({ ...f, intentText: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-sm text-espresso-soft">Prospecting searches (businesses that may need a better site)</span>
          <textarea className={`${input} font-mono text-sm`} rows={5} value={f.prospectText} disabled={disabled} onChange={(e) => setF({ ...f, prospectText: e.target.value })} />
        </label>
        <div className="grid grid-cols-3 gap-3 md:col-span-2">
          <label className="block">
            <span className="text-sm text-espresso-soft">Max age (days)</span>
            <input type="number" min={1} max={365} className={input} value={f.maxAgeDays} disabled={disabled} onChange={(e) => setF({ ...f, maxAgeDays: Number(e.target.value) })} />
          </label>
          <label className="block">
            <span className="text-sm text-espresso-soft">Searches per day</span>
            <input type="number" min={1} max={200} className={input} value={f.dailySearchLimit} disabled={disabled} onChange={(e) => setF({ ...f, dailySearchLimit: Number(e.target.value) })} />
          </label>
          <label className="block">
            <span className="text-sm text-espresso-soft">New pages per day</span>
            <input type="number" min={1} max={200} className={input} value={f.dailyCandidateLimit} disabled={disabled} onChange={(e) => setF({ ...f, dailyCandidateLimit: Number(e.target.value) })} />
          </label>
        </div>
        {canEdit ? (
          <div className="flex items-center gap-3 md:col-span-2">
            <button type="submit" id={`save-${id}`} className="rounded-lg bg-terracotta px-4 py-2 text-white disabled:opacity-50" disabled={disabled}>
              {m.isPending ? "Saving…" : "Save campaign"}
            </button>
            {onDone ? <button type="button" className="underline" onClick={onDone}>Cancel</button> : null}
            {m.isSuccess && !onDone ? <span role="status" className="text-sm text-espresso-soft">Saved.</span> : null}
          </div>
        ) : (
          <p className="text-sm text-espresso-soft md:col-span-2">Only operators and owners can change campaigns.</p>
        )}
        {m.error ? <div className="md:col-span-2"><Notice tone="error">{m.error.message}</Notice></div> : null}
      </form>
    </Panel>
  );
}
