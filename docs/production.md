# Running Growth Intelligence in production

Address: **https://growthintelligence.businesswebexpress.com**. Nothing here is done until the owner gives the go-ahead.

## What production is
- Worker `growth-intelligence` (the top level of `wrangler.jsonc`), cron every 15 minutes.
- GIE tables in schema `gie_prod`; BWE's live data is read (read-only) from schema `public`.
- Sign-in is a BWE back-office email, password and authenticator code. It uses no redirect or magic-link flow, so
  Supabase needs **no** new redirect URLs.

## Steps, in order
1. **Database (Supabase SQL editor).** Run `ALL-production-in-order.sql` (11 migrations, already rendered for `gie_prod`;
   in `/mnt/project-files/gie-production-sql/`). Run it once. Check: `select slug, name from gie_prod.gie_tenants;`
   returns one row, `bwe`. Every BWE admin becomes an owner of that workspace when the foundation file runs.
2. **Expose the schema.** Supabase, Project Settings, API, Exposed schemas: add `gie_prod`.
3. **GitHub.** Repository Settings, Environments: create `production` with the four secrets used for staging
   (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`) and turn on
   *Required reviewers* (the owner) so a deploy needs a second click.
4. **First deploy.** Actions, **Deploy production**, Run workflow, type `deploy production`. Wrangler creates the Worker and
   the custom domain; the DNS record is added automatically if `businesswebexpress.com` is a zone in the same
   Cloudflare account. If it is not, add a CNAME for `growthintelligence` to the Worker yourself.
5. **Worker secrets (once, after the first deploy):** `npx wrangler secret put <NAME>` for each of
   `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `BRAVE_SEARCH_API_KEY`,
   `PAGESPEED_API_KEY`, `LEAD_EMAIL_SMTP_USER`, `LEAD_EMAIL_SMTP_PASSWORD`, `UNSUBSCRIBE_SECRET` (same as BWE), and
   the IMAP settings if replies are to be read. Use BWE's production values, not staging's.
6. **Protect the address.** Put `growthintelligence.businesswebexpress.com` behind Cloudflare Access with an email allow-list
   (like BWE's admin) before anyone signs in.
7. **Check.** Sign in, confirm Settings shows the BWE workspace and "Reading Business Web Express data (schema public)".
   Nothing is sent until a person approves each email.

## Before real sending
- Production reads BWE's live leads and payments, and sends from BWE's real lead mailbox. Test with your own address first
  and keep the daily send cap low (`GIE_DAILY_SEND_CAP`, default 20).
- The unsubscribe link points at `UNSUBSCRIBE_BASE_URL` (default `https://businesswebexpress.com`).

## Staging
Staging is no longer needed once production is verified. To retire it: delete the `growth-intelligence-staging` Worker
(this also frees its cron trigger), remove the `env.staging` block and `deploy-staging.yml`, and drop the `gie_staging` schema
only after confirming nothing there is wanted.
