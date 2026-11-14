# Agency readiness (Phase 8)

How a client business gets its own isolated workspace, what limits it, and how the platform administrator watches over it.

## Creating a client workspace
Workspaces page (platform administrators only). Needs a name, an address (slug), a time zone, the owner's email, and a monthly
budget (default $20). The owner must already have an account: the page says so when they do not. Creation makes the workspace,
its default work schedule, a monthly budget, default limits, and the owner membership in one go, audits who did it, and removes
anything half-built if a step fails. The address `bwe` and a few route names are reserved.

## Limits (per workspace, set by a platform administrator only)
Active campaigns (default 3), team members (default 5), emails per day (can only be lower than the app-wide cap, which always
applies). They are enforced by database triggers, so no code path can skip them, and a workspace cannot raise its own. The
owner's BWE workspace is set high (50 and 50).

## Suspending
A platform administrator can suspend or reactivate a client workspace (not the BWE one). Suspension is enforced in the database:
a suspended workspace's members see nothing, in the app or through any direct query; platform administrators still can. The
scheduled jobs skip suspended workspaces.

## Monitoring
The Workspaces page shows, per workspace: members, active campaigns and emails in the last 24 hours against their limits, this
month's spend against the budget, failed job runs in 7 days, the last job, and a plain list of anything needing attention
(suspended, failed jobs, budget warning or stop, at a limit).

## Reports
The Reports page is a monthly report for the signed-in workspace only: results (leads, meetings, proposals, agreements,
customers, revenue; "not connected" for client workspaces), outreach, the month's daily effectiveness average, suggestions, and
spend. Read as the signed-in person, so it can only show their own workspace.

## What a client workspace cannot do yet
- **Send email.** The sender is BWE's lead mailbox and the unsubscribe and suppression lists are BWE's. Approval stays blocked
  for any other workspace ("No unsubscribe list is connected"), with a test. A client needs its own mailbox and lists first.
- **Read business records.** Leads, meetings, proposals and payments are read for the BWE workspace only, so a client's results
  show "Not connected".
- **Edit its budget.** Set at creation; changing it later is a database change for now.

## Decisions for the owner before real clients
1. **Split staging into its own Supabase project** (risk S1 in the plan): staging and production share one project, one service
   key and one user table today. Do this before onboarding any client.
2. **How clients sign in.** Sign-in uses accounts that already exist; whether clients get their own accounts, and whether they
   must use an authenticator code, is not decided.
3. **Client mailbox and unsubscribe list** (above).

See `security-checklist.md` for the cross-tenant checks and how each is tested.
