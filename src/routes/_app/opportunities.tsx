import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getOpportunities, setOpportunityStatus, type OpportunityCard } from "@/lib/discovery.functions";
import { useWorkspace } from "@/lib/use-workspace";
import { EmptyState, Notice, PageHeader } from "@/components/ui";

export const Route = createFileRoute("/_app/opportunities")({ component: Page });

const BAND: Record<string, { label: string; cls: string }> = {
  very_high: { label: "Very high", cls: "bg-terracotta text-white" },
  high: { label: "High", cls: "bg-terracotta/15 text-terracotta" },
  review: { label: "Review", cls: "bg-parchment-deep text-espresso" },
  low: { label: "Low", cls: "bg-parchment text-espresso-soft" },
};
const COMPONENT_LABEL: Record<string, string> = { intent: "Intent", fit: "Fit", freshness: "Freshness", reachability: "Reachability", evidence: "Evidence" };
const QUOTE_LABEL: Record<string, string> = {
  business_name_quote: "Business",
  industry_quote: "Industry",
  location_quote: "Location",
  intent_quote: "Intent",
  published_date_quote: "Date",
};

type StatusFilter = "open" | "new" | "saved" | "pursuing" | "dismissed" | "archived";
type SignalFilter = "all" | "buying_intent" | "prospecting";

function Page() {
  const { tenant } = useWorkspace();
  const [status, setStatus] = useState<StatusFilter>("open");
  const [signal, setSignal] = useState<SignalFilter>("all");
  const fetchList = useServerFn(getOpportunities);
  const q = useQuery({
    queryKey: ["opportunities", tenant.slug, status, signal],
    queryFn: () => fetchList({ data: { slug: tenant.slug, status, signal } }),
  });
  const select = "rounded-lg border border-line bg-card px-3 py-2";

  return (
    <>
      <PageHeader
        title="Opportunities"
        description="Businesses found by discovery, with the page they came from, the exact quotes behind each claim, and how the Opportunity Score was worked out."
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="text-sm">
          <span className="sr-only">Status</span>
          <select className={select} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="open">Open (new, saved, pursuing)</option>
            <option value="new">New</option>
            <option value="saved">Saved</option>
            <option value="pursuing">Pursuing</option>
            <option value="dismissed">Dismissed</option>
            <option value="archived">Archived</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="sr-only">Signal</span>
          <select className={select} value={signal} onChange={(e) => setSignal(e.target.value as SignalFilter)}>
            <option value="all">Both signal types</option>
            <option value="buying_intent">Buying intent only</option>
            <option value="prospecting">Prospecting only</option>
          </select>
        </label>
      </div>
      {q.isLoading ? <p role="status" className="text-espresso-soft">Loading…</p> : null}
      {q.error ? <Notice tone="error">{q.error.message}</Notice> : null}
      {q.data && q.data.items.length === 0 ? (
        <EmptyState title="No opportunities here yet">
          Opportunities appear after an active campaign's overnight search and the classification that follows. Check Campaigns for the discovery status.
        </EmptyState>
      ) : null}
      <ul className="space-y-4">
        {q.data?.items.map((o) => <OpportunityItem key={o.id} o={o} canAct={q.data.canAct} />)}
      </ul>
    </>
  );
}

function OpportunityItem({ o, canAct }: { o: OpportunityCard; canAct: boolean }) {
  const { tenant } = useWorkspace();
  const qc = useQueryClient();
  const setStatus = useServerFn(setOpportunityStatus);
  const [open, setOpen] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: (v: { status: "saved" | "pursuing" | "dismissed" | "archived" | "new"; reason?: string }) =>
      setStatus({ data: { slug: tenant.slug, id: o.id, ...v } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["opportunities", tenant.slug] }),
  });
  const band = o.band ? BAND[o.band] : null;
  const btn = "rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-50";

  return (
    <li className="rounded-2xl border border-line bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-terracotta">
            {o.signalType === "buying_intent" ? "Buying intent" : "Prospecting"} · {o.status}
          </p>
          <h2 className="font-display text-lg font-semibold">{o.businessName}</h2>
          <p className="text-sm text-espresso-soft">
            {[o.industry, o.location].filter(Boolean).join(" · ") || "Industry and location not stated"} · found {new Date(o.discoveredAt).toLocaleDateString()}
          </p>
          <p className="mt-1 text-sm">
            {o.websiteUrl ? <a className="text-terracotta underline" href={o.websiteUrl} target="_blank" rel="noopener noreferrer nofollow">Website</a> : <span className="text-espresso-soft">Website not verified</span>}
            {" · "}
            <a className="text-terracotta underline" href={o.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">Source page</a>
          </p>
        </div>
        <div className="text-right">
          {o.score !== null ? (
            <>
              <p className="font-display text-3xl font-semibold leading-none">{o.score}</p>
              {band ? <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs ${band.cls}`}>{band.label}</span> : null}
            </>
          ) : (
            <p className="text-sm text-espresso-soft">Not scored</p>
          )}
        </div>
      </div>

      {o.summary ? <p className="mt-3">{o.summary}</p> : null}
      {o.pagespeed ? (
        <p className="mt-2 text-sm text-espresso-soft">
          PageSpeed (mobile): performance {o.pagespeed.performance ?? "n/a"}, SEO {o.pagespeed.seo ?? "n/a"}, accessibility {o.pagespeed.accessibility ?? "n/a"}
        </p>
      ) : null}

      {o.brokenLinks ? <p className="mt-2 text-sm text-espresso-soft">Broken links: {o.brokenLinks}</p> : null}

      <button className="mt-3 text-sm underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide evidence and score" : "Show evidence and score"}
      </button>
      {open ? (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <p className="text-sm font-medium">Exact quotes from the page</p>
            {o.quotes.length ? (
              <ul className="mt-1 space-y-1 text-sm">
                {o.quotes.map((x) => (
                  <li key={x.field}><span className="text-espresso-soft">{QUOTE_LABEL[x.field] ?? x.field}:</span> “{x.quote}”</li>
                ))}
              </ul>
            ) : <p className="mt-1 text-sm text-espresso-soft">No quotes recorded.</p>}
            {o.model ? <p className="mt-2 text-xs text-espresso-soft">Classified by {o.model}. Quotes were checked word for word against the fetched page.</p> : null}
          </div>
          <div>
            <p className="text-sm font-medium">How the score was worked out{o.ruleVersion ? ` (${o.ruleVersion})` : ""}</p>
            <table className="mt-1 w-full text-sm">
              <tbody>
                {o.components.map((c) => (
                  <tr key={c.component} className="border-t border-line align-top">
                    <td className="py-1 pr-2">{COMPONENT_LABEL[c.component] ?? c.component}</td>
                    <td className="py-1 pr-2 text-right font-mono">{c.points.toFixed(1)}/{c.weight}</td>
                    <td className="py-1 text-espresso-soft">{c.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {canAct ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {o.status !== "pursuing" ? <button className={btn} disabled={m.isPending} onClick={() => m.mutate({ status: "pursuing" })}>Pursue</button> : null}
          {o.status !== "saved" ? <button className={btn} disabled={m.isPending} onClick={() => m.mutate({ status: "saved" })}>Save</button> : null}
          {o.status !== "dismissed" ? <button className={btn} disabled={m.isPending} onClick={() => setDismissing((v) => !v)}>Dismiss</button> : null}
          {o.status !== "archived" ? <button className={btn} disabled={m.isPending} onClick={() => m.mutate({ status: "archived" })}>Archive</button> : null}
          {o.status === "dismissed" || o.status === "archived" ? <button className={btn} disabled={m.isPending} onClick={() => m.mutate({ status: "new" })}>Reopen</button> : null}
        </div>
      ) : null}
      {dismissing ? (
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate({ status: "dismissed", reason }, { onSuccess: () => setDismissing(false) });
          }}
        >
          <label className="flex-1">
            <span className="sr-only">Why dismiss</span>
            <input className="w-full rounded-lg border border-line px-3 py-1.5 text-sm" placeholder="Why? (e.g. not a fit, already has a new site)" value={reason} required maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className={btn} type="submit" disabled={m.isPending || !reason.trim()}>Dismiss</button>
        </form>
      ) : null}
      {o.dismissReason ? <p className="mt-2 text-sm text-espresso-soft">Dismissed: {o.dismissReason}</p> : null}
      {m.error ? <div className="mt-2"><Notice tone="error">{m.error.message}</Notice></div> : null}
    </li>
  );
}
