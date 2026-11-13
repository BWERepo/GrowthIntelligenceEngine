# Growth Intelligence Engine (GIE): instructions for working on this repository

Standalone app for Business Web Express: discovers opportunities, prepares the day's actions, reviews the day and
measures 30-day growth. The plan, decisions and phase list are in `docs/growth-intelligence-discovery.md`; read it first.

## Architecture in one paragraph
TanStack Start on its own Cloudflare Worker (`growth-intelligence`, staging `growth-intelligence-staging`). Same Supabase
project as BWE: GIE's tables live in `gie_staging` / `gie_prod`; BWE's schema of the same environment (`bwe_staging` /
`public`) is **read-only** from here. Sign-in uses BWE back-office accounts (including their authenticator codes).

## Rules
1. **Tenant isolation is the first rule.** Every GIE table has `tenant_id`, RLS enabled, and policies through
   `has_tenant_role()`. Never grant access on "authenticated" alone (HDBS users and BWE customers share `auth.users`).
   Service-role queries bypass RLS: check the caller's tenant role in the server function first.
2. **Never write to BWE's schema.** Read it through `src/lib/bwe-source.server.ts` only, and only for the BWE tenant.
3. **Migrations** are templates with `__SCHEMA__` (GIE schema) and `__BWE_SCHEMA__` (BWE schema). Render with
   `npm run migrate:render -- <file> --split` and paste into the Supabase SQL editor: staging first. Every new table needs
   RLS tests in `tests/db/rls.test.sql`.
4. **No fabricated data.** Empty states say what is missing; scores and metrics come only from recorded data.
5. **Three separate measurements** (Opportunity Score, Daily Effectiveness Score, 30-Day Growth) are never combined, and
   the 30-day panel is always the most prominent.
6. **Outreach is never sent without a person approving it.**
7. **Checks before every PR:** `npm run typecheck`, `npm test`, `npm run test:db` (needs local Postgres binaries, run as a
   non-root user), `npm run build`. Report real results.
8. **Staging first.** Deploy staging, verify, and deploy production only with the owner's explicit go-ahead.
   Bump `version.json` (`yyyy.mm.dd.nn`) with each change.
9. No secrets in the repository. Local values go in `.dev.vars` (git-ignored).
10. Phases need the owner's explicit approval before the next one starts.
