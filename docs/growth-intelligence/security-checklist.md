# Cross-tenant security checklist

Each row is a way one workspace could reach another's data, and where it is tested. Run `npm test` and `npm run test:db` (as a
non-root user) before every release.

| # | Check | Test |
|---|---|---|
| 1 | Every GIE table has row level security and a `tenant_id` (future tables too) | DB: structural check, section 29 |
| 2 | Every policy goes through `has_tenant_role()`, never "signed in" alone | DB: structural check, section 29 |
| 3 | Users of another workspace, BWE customers and other sites' users see nothing, per feature area | DB: one block per phase |
| 4 | Users cannot write server-written tables; the server cannot rewrite or delete permanent records | DB: per phase |
| 5 | A row cannot point at another workspace's row (composite foreign keys) | DB: per phase |
| 6 | A suspended workspace's members lose access in the database, platform administrators keep it | DB: section 30 |
| 7 | Limits (campaigns, team, emails) are enforced by the database and cannot be raised by the workspace | DB: section 31, unit: agency |
| 8 | Platform administrator needs the second authenticator step (aal2) | DB: section 6 |
| 9 | Every server function checks the caller's workspace role or platform admin before using the service role | Unit: scans every `*.functions.ts` |
| 10 | Outreach cannot be approved or sent for a workspace with no unsubscribe list of its own | Unit: agency, send |
| 11 | BWE's tables are only read, and only for the BWE workspace | Unit: growth sync (no writes), suppression |
| 12 | No secrets in the repository | Manual: review before each PR |

Not covered by automated tests, to check by hand on staging before the first client: that a client user's sign-in cannot open
another workspace by changing the `t` address parameter (the server rejects it, but verify with a real second account), and
that the Worker's environment holds no BWE-only secrets a client path could reach.
