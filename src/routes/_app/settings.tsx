import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getTenantSettings, saveDailyFocus, saveMailSettings, type TenantSettings } from "@/lib/workspace.functions";
import { FOCUSES, FOCUS_LABELS, type Focus } from "@/lib/actions/ranking";
import { useWorkspace } from "@/lib/use-workspace";
import { Notice, PageHeader, Panel } from "@/components/ui";

export const Route = createFileRoute("/_app/settings")({ component: SettingsPage });

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function SettingsPage() {
  const { tenant } = useWorkspace();
  const fetchSettings = useServerFn(getTenantSettings);
  const q = useQuery({ queryKey: ["settings", tenant.slug], queryFn: () => fetchSettings({ data: { slug: tenant.slug } }) });

  const qc = useQueryClient();
  const saveFocus = useServerFn(saveDailyFocus);
  const [pick, setPick] = useState<Focus | null>(null);
  const focusM = useMutation({
    mutationFn: (focus: Focus) => saveFocus({ data: { slug: tenant.slug, focus } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["settings", tenant.slug] });
      setPick(null);
    },
  });

  return (
    <>
      <PageHeader title="Settings" description="Workspace, schedule, spending cap, team and data connections." />
      {q.isLoading ? <p role="status" className="text-espresso-soft">Loading…</p> : null}
      {q.error ? <Notice tone="error">{q.error.message}</Notice> : null}
      {q.data ? (
        <div className="grid gap-5 md:grid-cols-2">
          <Panel title="Workspace">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
              <dt className="text-espresso-soft">Name</dt><dd>{q.data.tenant.name}</dd>
              <dt className="text-espresso-soft">Time zone</dt><dd>{q.data.tenant.timezone}</dd>
              <dt className="text-espresso-soft">Your role</dt><dd className="capitalize">{q.data.tenant.role}</dd>
            </dl>
          </Panel>
          <Panel title="Work schedule">
            {q.data.schedule ? (
              <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
                <dt className="text-espresso-soft">Working days</dt><dd>{q.data.schedule.workingDays.map((d) => DAY_NAMES[d]).join(", ")}</dd>
                <dt className="text-espresso-soft">Morning package</dt><dd>{q.data.schedule.morningTime.slice(0, 5)}</dd>
                <dt className="text-espresso-soft">End-of-day review</dt><dd>{q.data.schedule.eveningTime.slice(0, 5)}</dd>
                <dt className="text-espresso-soft">Daily focus</dt>
                <dd>
                  {q.data.tenant.role === "owner" ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <select aria-label="Daily focus" className="rounded border border-espresso/30 bg-transparent px-2 py-1" value={pick ?? q.data.schedule.dailyFocus} disabled={focusM.isPending} onChange={(e) => { focusM.reset(); setPick(e.target.value as Focus); }}>
                        {FOCUSES.map((f) => <option key={f} value={f}>{FOCUS_LABELS[f]}</option>)}
                      </select>
                      <button type="button" className="rounded-lg bg-terracotta px-4 py-1.5 text-white disabled:opacity-50" disabled={focusM.isPending || pick === null || pick === q.data.schedule.dailyFocus} onClick={() => pick && focusM.mutate(pick)}>
                        {focusM.isPending ? "Saving…" : "Save"}
                      </button>
                    </div>
                  ) : FOCUS_LABELS[q.data.schedule.dailyFocus]}
                  {focusM.error ? <span role="alert" className="block text-sm text-red-700">{focusM.error.message}</span> : <span role="status" className="block text-sm text-espresso-soft">{focusM.isSuccess ? "Saved. " : ""}Applies from the next morning package.</span>}
                </dd>
              </dl>
            ) : <p className="text-espresso-soft">No schedule set.</p>}
          </Panel>
          <Panel title="Spending cap (AI and search)">
            {q.data.budgets.length ? (
              <ul className="space-y-1">
                {q.data.budgets.map((b) => (
                  <li key={`${b.category}-${b.period}`}>
                    <span className="capitalize">{b.category}</span> per {b.period}: <strong>{money.format(b.limitUsd)}</strong>
                    <span className="text-espresso-soft"> · alerts at {b.alertAt.map((a) => `${Math.round(a * 100)}%`).join(" and ")}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-espresso-soft">No cap set. Paid work stays off until one is.</p>}
          </Panel>
          <Panel title="Team">
            <ul className="space-y-1">
              {q.data.members.map((m) => (
                <li key={m.userId} className="flex justify-between gap-3">
                  <span className="truncate">{m.email ?? "Member"}{m.isYou ? " (you)" : ""}</span>
                  <span className="capitalize text-espresso-soft">{m.role}</span>
                </li>
              ))}
            </ul>
          </Panel>
          {q.data.mail ? <MailPanel key={JSON.stringify(q.data.mail.settings)} slug={tenant.slug} mail={q.data.mail} isOwner={q.data.tenant.role === "owner"} /> : null}
          {q.data.bwe ? (
            <Panel title="Data connections">
              {q.data.bwe.ok ? (
                <p>
                  Reading Business Web Express data (schema <code className="font-mono text-xs">{q.data.bwe.schema}</code>, read-only):{" "}
                  {q.data.bwe.leadsTotal} leads on record, {q.data.bwe.leadsLast30Days} in the last 30 days.
                </p>
              ) : (
                <Notice tone="error">{q.data.bwe.reason}</Notice>
              )}
            </Panel>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

type MailView = NonNullable<TenantSettings["mail"]>;

function MailPanel({ slug, mail, isOwner }: { slug: string; mail: MailView; isOwner: boolean }) {
  const qc = useQueryClient();
  const save = useServerFn(saveMailSettings);
  const [fromName, setFromName] = useState(mail.settings.fromName);
  const [fromEmail, setFromEmail] = useState(mail.settings.fromEmail ?? "");
  const [replyTo, setReplyTo] = useState(mail.settings.replyTo ?? "");
  const m = useMutation({
    mutationFn: () => save({ data: { slug, fromName, fromEmail, replyTo } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", slug] }),
  });
  const input = "mt-1 w-full rounded-lg border border-line bg-card px-3 py-2 outline-none focus:border-terracotta disabled:opacity-60";
  const missing = [!mail.loginUser && "LEAD_EMAIL_SMTP_USER", !mail.passwordSet && "LEAD_EMAIL_SMTP_PASSWORD", !mail.unsubscribeSecretSet && "UNSUBSCRIBE_SECRET"].filter(Boolean);
  const changed = fromName !== mail.settings.fromName || fromEmail.trim() !== (mail.settings.fromEmail ?? "") || replyTo.trim() !== (mail.settings.replyTo ?? "");
  const replyElsewhere = replyTo.trim() !== "" && mail.repliesMailbox !== null && replyTo.trim().toLowerCase() !== mail.repliesMailbox.toLowerCase();
  return (
    <Panel title="Outreach email">
      <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
        <dt className="text-espresso-soft">Emails appear from</dt>
        <dd>{mail.shownFrom ? <><strong>{mail.settings.fromName}</strong> &lt;{mail.shownFrom}&gt;</> : <span className="text-espresso-soft">Not set up</span>}</dd>
        <dt className="text-espresso-soft">Mailbox login</dt>
        <dd>{mail.loginUser ?? <span className="text-espresso-soft">Not set</span>}{mail.loginUser ? (mail.passwordSet ? "" : " (password missing)") : ""}</dd>
        <dt className="text-espresso-soft">Replies read from</dt>
        <dd>{mail.repliesMailbox ?? <span className="text-espresso-soft">Not set</span>}</dd>
      </dl>
      {missing.length ? <div className="mt-3"><Notice tone="error">Sending is off until these Worker secrets are set: {missing.join(", ")}.</Notice></div> : null}
      <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <label className="block">Sender name
          <input className={input} value={fromName} disabled={!isOwner || m.isPending} onChange={(e) => setFromName(e.target.value)} />
        </label>
        <label className="block">Send-as address <span className="text-espresso-soft">(blank = the mailbox login)</span>
          <input className={input} type="email" value={fromEmail} placeholder={mail.loginUser ?? "growth@businesswebexpress.com"} disabled={!isOwner || m.isPending} onChange={(e) => setFromEmail(e.target.value)} />
        </label>
        <label className="block">Reply-to address <span className="text-espresso-soft">(optional)</span>
          <input className={input} type="email" value={replyTo} disabled={!isOwner || m.isPending} onChange={(e) => setReplyTo(e.target.value)} />
        </label>
        <p className="text-sm text-espresso-soft">
          The send-as address must be the mailbox login itself or an alias that mailbox is allowed to send as (in Gmail: Settings, Accounts, "Send mail as"), or the provider may change it or reject the email.
          The mailbox login and password are Worker secrets and are not changed here.
        </p>
        {replyElsewhere ? <Notice>Replies to a different mailbox than "Replies read from" will not be detected by this app.</Notice> : null}
        {m.error ? <Notice tone="error">{m.error.message}</Notice> : null}
        {isOwner ? (
          <div className="flex items-center gap-3">
            <button type="submit" className="rounded-lg bg-terracotta px-4 py-2 text-white disabled:opacity-50" disabled={m.isPending || !changed}>{m.isPending ? "Saving…" : "Save"}</button>
            {m.isSuccess && !changed ? <span role="status" className="text-sm text-espresso-soft">Saved. Applies to the next email sent.</span> : null}
          </div>
        ) : <p className="text-sm text-espresso-soft">Only the workspace owner can change these.</p>}
      </form>
    </Panel>
  );
}
