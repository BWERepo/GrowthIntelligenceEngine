import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { EmptyState, Notice, PageHeader, Panel } from "@/components/ui";
import { EffectivenessSummary } from "@/components/effectiveness";
import { GrowthSummary } from "@/components/growth";
import { useWorkspace } from "@/lib/use-workspace";
import {
  addFollowUp,
  approveDraft,
  buildPackageNow,
  discardDraft,
  editDraft,
  getDailyPackage,
  getReplies,
  markReplyHandled,
  sendDraft,
  setDoNotContact,
  setItemStatus,
  type ActionItem,
} from "@/lib/actions.functions";

export const Route = createFileRoute("/_app/")({ component: DailyActionCenter });

const STATUS_LABEL: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
  deferred: "Deferred",
  blocked: "Blocked",
  awaiting_response: "Awaiting response",
  cancelled: "Cancelled",
};

// Visual order is fixed by the spec: 30-day growth first and largest, today's
// actions second, the daily effectiveness score last and smallest. No numbers
// are shown until real recorded data exists.
function DailyActionCenter() {
  const { tenant } = useWorkspace();
  const today = new Intl.DateTimeFormat("en-US", { timeZone: tenant.timezone, weekday: "long", month: "long", day: "numeric" }).format(new Date());
  const fetchPkg = useServerFn(getDailyPackage);
  const q = useQuery({ queryKey: ["package", tenant.slug], queryFn: () => fetchPkg({ data: { slug: tenant.slug } }) });
  return (
    <>
      <PageHeader title="Daily Action Center" description={`${today}. The most valuable things to do today to win business.`} />
      <div className="space-y-5">
        <Panel kicker="Primary" title="30-Day Growth Performance" emphasis="primary">
          <GrowthSummary />
        </Panel>
        <Panel kicker="Today" title="Today's priority actions">
          {q.isLoading ? <p role="status" className="text-espresso-soft">Loading…</p> : null}
          {q.error ? <Notice tone="error">{q.error.message}</Notice> : null}
          {q.data && !q.data.generated ? <NoPackage canBuild={tenant.role === "owner"} /> : null}
          {q.data?.generated && q.data.items.length === 0 ? (
            <EmptyState title="No verified actions today">
              Nothing qualified for today's package: no follow-up is due and no scored opportunity is open. Discovery runs overnight (see Campaigns).
            </EmptyState>
          ) : null}
          {q.data?.generated?.late ? <p className="mb-3 text-sm text-espresso-soft">Generated late, after the usual morning time.</p> : null}
          <ol className="space-y-4">
            {q.data?.items.map((i) => <ActionCard key={i.id} item={i} canAct={q.data.canAct} />)}
          </ol>
        </Panel>
        {tenant.role !== "viewer" ? <RepliesPanel /> : null}
        <Panel kicker="Supporting" title="Daily Effectiveness" emphasis="supporting">
          <EffectivenessSummary />
        </Panel>
      </div>
    </>
  );
}

function RepliesPanel() {
  const { tenant } = useWorkspace();
  const qc = useQueryClient();
  const fetchReplies = useServerFn(getReplies);
  const handle = useServerFn(markReplyHandled);
  const q = useQuery({ queryKey: ["replies", tenant.slug], queryFn: () => fetchReplies({ data: { slug: tenant.slug } }) });
  const done = useMutation({ mutationFn: (replyId: string) => handle({ data: { slug: tenant.slug, replyId } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["replies", tenant.slug] }) });
  const label = { reply: "Reply", auto_reply: "Automatic reply", bounce: "Bounced" } as const;
  return (
    <Panel kicker="Needs attention" title="Replies to your outreach">
      {q.error ? <Notice tone="error">{q.error.message}</Notice> : null}
      {q.data && q.data.length === 0 ? <p className="text-espresso-soft">No new replies. The mailbox is checked every 15 minutes, read-only.</p> : null}
      <ul className="space-y-3">
        {q.data?.map((r) => (
          <li key={r.id} className="rounded-xl border border-line p-3">
            <p className="font-medium">{r.businessName} <span className="text-sm font-normal text-espresso-soft">· {label[r.kind]} · {new Date(r.receivedAt).toLocaleString()}</span></p>
            {r.subject ? <p className="text-sm">{r.subject}</p> : null}
            {r.snippet ? <p className="mt-1 text-sm text-espresso-soft">{r.snippet}</p> : null}
            {r.kind === "bounce" ? <p className="mt-1 text-sm text-espresso-soft">This address is now marked do-not-contact.</p> : null}
            <button className="mt-2 rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-50" disabled={done.isPending} onClick={() => done.mutate(r.id)}>Mark handled</button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function NoPackage({ canBuild }: { canBuild: boolean }) {
  const { tenant } = useWorkspace();
  const qc = useQueryClient();
  const build = useServerFn(buildPackageNow);
  const m = useMutation({ mutationFn: () => build({ data: { slug: tenant.slug } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["package", tenant.slug] }) });
  return (
    <div>
      <EmptyState title="Today's package has not been prepared yet">
        It is prepared each business morning at the workspace's morning time ({tenant.timezone}). It needs an active campaign and at least one scored opportunity or due follow-up.
      </EmptyState>
      {canBuild ? (
        <div className="mt-3">
          <button className="rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? "Preparing…" : "Prepare today's package now"}</button>
          {m.data ? <p role="status" className="mt-2 text-sm">{m.data.status === "created" ? `Prepared ${m.data.items} action(s) and ${m.data.drafts} draft(s).` : `Not prepared: ${m.data.reason}.`}</p> : null}
          {m.error ? <div className="mt-2"><Notice tone="error">{m.error.message}</Notice></div> : null}
        </div>
      ) : null}
    </div>
  );
}

function ActionCard({ item, canAct }: { item: ActionItem; canAct: boolean }) {
  const { tenant } = useWorkspace();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["package", tenant.slug] });
  const status = useServerFn(setItemStatus);
  const dnc = useServerFn(setDoNotContact);
  const st = useMutation({ mutationFn: (s: ActionItem["status"]) => status({ data: { slug: tenant.slug, itemId: item.id, status: s } }), onSuccess: refresh });
  const followUp = useServerFn(addFollowUp);
  const fu = useMutation({ mutationFn: () => followUp({ data: { slug: tenant.slug, prospectId: item.prospect!.id, inDays: 7 } }), onSuccess: refresh });
  const noContact = useMutation({
    mutationFn: (reason: string) => dnc({ data: { slug: tenant.slug, prospectId: item.prospect!.id, reason } }),
    onSuccess: refresh,
  });
  const o = item.opportunity;
  const name = o?.businessName ?? item.prospect?.businessName ?? "Follow-up";
  const btn = "rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-50";
  return (
    <li className="rounded-2xl border border-line bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-terracotta">#{item.rank} · {item.kind === "follow_up" ? "Follow-up" : o?.signalType === "buying_intent" ? "Buying intent" : "Prospecting"} · {item.effort} effort</p>
          <h3 className="font-display text-lg font-semibold">{name}</h3>
          <p className="mt-1">{item.recommendedAction}</p>
          {o ? (
            <p className="mt-1 text-sm">
              {o.websiteUrl ? <a className="text-terracotta underline" href={o.websiteUrl} target="_blank" rel="noopener noreferrer nofollow">Website</a> : null}
              {o.websiteUrl ? " · " : ""}
              <a className="text-terracotta underline" href={o.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">Source page</a>
            </p>
          ) : null}
          {item.followUp?.note ? <p className="mt-1 text-sm text-espresso-soft">{item.followUp.note}</p> : null}
        </div>
        <div className="text-right text-sm">
          {o?.score != null ? <p><span className="font-display text-2xl font-semibold">{o.score}</span> <span className="text-espresso-soft">Opportunity Score</span></p> : null}
          <p className="text-espresso-soft">{STATUS_LABEL[item.status]}</p>
        </div>
      </div>

      {item.draft && canAct ? <DraftEditor draft={item.draft} onChanged={refresh} /> : null}

      {canAct ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {item.status !== "in_progress" ? <button className={btn} disabled={st.isPending} onClick={() => st.mutate("in_progress")}>Start</button> : null}
          {item.status !== "completed" ? <button className={btn} disabled={st.isPending} onClick={() => st.mutate("completed")}>Mark complete</button> : null}
          {item.status !== "awaiting_response" ? <button className={btn} disabled={st.isPending} onClick={() => st.mutate("awaiting_response")}>Awaiting response</button> : null}
          {item.status !== "deferred" ? <button className={btn} disabled={st.isPending} onClick={() => st.mutate("deferred")}>Defer</button> : null}
          {item.status !== "blocked" ? <button className={btn} disabled={st.isPending} onClick={() => st.mutate("blocked")}>Block</button> : null}
          {item.prospect && !item.prospect.doNotContact ? (
            <button className={btn} disabled={fu.isPending || fu.isSuccess} onClick={() => fu.mutate()}>{fu.isSuccess ? "Follow-up set for 7 days" : "Follow up in 7 days"}</button>
          ) : null}
          {item.prospect && !item.prospect.doNotContact ? (
            <button className={btn} disabled={noContact.isPending} onClick={() => noContact.mutate("Marked do-not-contact from the Daily Action Center")}>Do not contact</button>
          ) : null}
        </div>
      ) : null}
      {item.prospect?.doNotContact ? <p className="mt-2 text-sm text-destructive">Marked do-not-contact. No outreach will be approved.</p> : null}
      {st.error ? <div className="mt-2"><Notice tone="error">{st.error.message}</Notice></div> : null}
      {fu.error ? <div className="mt-2"><Notice tone="error">{fu.error.message}</Notice></div> : null}
      {noContact.error ? <div className="mt-2"><Notice tone="error">{noContact.error.message}</Notice></div> : null}
    </li>
  );
}

function DraftEditor({ draft, onChanged }: { draft: NonNullable<ActionItem["draft"]>; onChanged: () => void }) {
  const { tenant } = useWorkspace();
  const edit = useServerFn(editDraft);
  const approve = useServerFn(approveDraft);
  const discard = useServerFn(discardDraft);
  const sendIt = useServerFn(sendDraft);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [followUp, setFollowUp] = useState(draft.followUpBody ?? "");
  const dirty = subject !== draft.subject || body !== draft.body || followUp !== (draft.followUpBody ?? "");
  const approved = draft.status === "approved";
  const save = useMutation({ mutationFn: () => edit({ data: { slug: tenant.slug, draftId: draft.id, subject, body, followUpBody: followUp || null } }), onSuccess: onChanged });
  const ok = useMutation({
    mutationFn: async () => {
      if (dirty) await edit({ data: { slug: tenant.slug, draftId: draft.id, subject, body, followUpBody: followUp || null } });
      return approve({ data: { slug: tenant.slug, draftId: draft.id } });
    },
    onSuccess: onChanged,
  });
  const send = useMutation({ mutationFn: () => sendIt({ data: { slug: tenant.slug, draftId: draft.id } }), onSuccess: onChanged });
  const sent = draft.status === "sent";
  const gone = useMutation({ mutationFn: () => discard({ data: { slug: tenant.slug, draftId: draft.id } }), onSuccess: onChanged });
  const input = "w-full rounded-lg border border-line bg-card px-3 py-2 disabled:opacity-70";
  const result = ok.data && !ok.data.ok ? ok.data : null;
  const v = result?.validation ?? draft.validation;
  return (
    <div className="mt-4 rounded-xl border border-line bg-parchment p-4">
      <p className="text-sm font-medium">Outreach draft {sent ? `(sent ${draft.sentAt ? new Date(draft.sentAt).toLocaleString() : ""})` : approved ? "(approved, not sent yet)" : "(needs your approval)"}</p>
      <p className="text-xs text-espresso-soft">{sent ? "This email went out from the BWE lead mailbox. Replies appear under Replies." : "Approving records that you reviewed this exact text. It is sent only when you press Send."}</p>
      <label className="mt-2 block text-sm">Subject<input className={input} value={subject} disabled={approved || sent} maxLength={200} onChange={(e) => setSubject(e.target.value)} /></label>
      <label className="mt-2 block text-sm">Message<textarea className={input} rows={9} value={body} disabled={approved || sent} onChange={(e) => setBody(e.target.value)} /></label>
      <label className="mt-2 block text-sm">Follow-up for a week later<textarea className={input} rows={4} value={followUp} disabled={approved || sent} onChange={(e) => setFollowUp(e.target.value)} /></label>
      {v.errors.length ? <ul className="mt-2 text-sm text-destructive">{v.errors.map((e) => <li key={e.rule + e.message}>Must fix: {e.message}</li>)}</ul> : null}
      {v.warnings.length ? <ul className="mt-2 text-sm text-espresso-soft">{v.warnings.map((e) => <li key={e.rule + e.message}>Check: {e.message}</li>)}</ul> : null}
      {result ? <div className="mt-2"><Notice tone="error">{result.reason}</Notice></div> : null}
      {!approved && !sent ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="rounded-lg bg-terracotta px-4 py-2 text-white disabled:opacity-50" disabled={ok.isPending || gone.isPending} onClick={() => ok.mutate()}>{ok.isPending ? "Checking…" : "Approve this email"}</button>
          <button className="rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save changes</button>
          <button className="rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50" disabled={gone.isPending} onClick={() => gone.mutate()}>Discard</button>
        </div>
      ) : null}
      {approved ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="rounded-lg bg-terracotta px-4 py-2 text-white disabled:opacity-50" disabled={send.isPending || gone.isPending} onClick={() => { if (window.confirm(`Send this email to the prospect now? It cannot be recalled.`)) send.mutate(); }}>{send.isPending ? "Sending…" : "Send now"}</button>
          <button className="rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50" disabled={send.isPending || gone.isPending} onClick={() => gone.mutate()}>Discard</button>
        </div>
      ) : null}
      {draft.sendError && approved ? <div className="mt-2"><Notice tone="error">Last attempt failed: {draft.sendError}</Notice></div> : null}
      {send.data && !send.data.ok ? <div className="mt-2"><Notice tone="error">{send.data.reason}</Notice></div> : null}
      {ok.error || save.error || gone.error || send.error ? <div className="mt-2"><Notice tone="error">{(ok.error ?? save.error ?? gone.error ?? send.error)!.message}</Notice></div> : null}
    </div>
  );
}
