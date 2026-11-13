# Setting up Growth Intelligence on staging

Everything below is a one-time setup. Nothing here touches production.

## 1. Database (Supabase SQL editor)

1. Render the migration: `npm run migrate:render -- supabase/migrations/20261113150000_gie_foundation.sql --split`.
   This writes `…gie_foundation.staging.sql` and `…gie_foundation.production.sql` next to it (both git-ignored).
2. Paste the **staging** file into the Supabase SQL editor and run it. It creates the `gie_staging` schema, the
   foundation tables with row-level security, the BWE workspace, its 8:00/17:00 schedule, the $50/month cap, and makes
   every BWE staging admin an owner of the workspace.
3. Check: `select slug, name from gie_staging.gie_tenants;` returns one row, `bwe`.
4. **Expose the schema to the API:** Supabase → Project Settings → API (Data API) → *Exposed schemas* → add
   `gie_staging` (later also `gie_prod`). Without this every request fails with "schema must be one of …".

Production (`gie_prod`) is run the same way only after staging is approved.

## 2. GitHub secrets (this repository → Settings → Secrets and variables → Actions → environment `staging`)

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A token with *Workers Scripts: Edit* for the account (can be the same kind BWE uses) |
| `CLOUDFLARE_ACCOUNT_ID` | Same account as BWE |
| `SUPABASE_URL` | Same as BWE (`https://<project>.supabase.co`) |
| `SUPABASE_PUBLISHABLE_KEY` | Same publishable (anon) key as BWE |

## 3. Worker secret (once, after the first deploy creates the Worker)

```
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
npx wrangler secret put SUPABASE_URL --env staging
npx wrangler secret put SUPABASE_PUBLISHABLE_KEY --env staging
```

## 4. Deploy and check

1. Actions → **Deploy staging** → Run workflow.
2. Open the `growth-intelligence-staging` URL Wrangler prints (workers.dev). Recommended: put it behind
   Cloudflare Access (email allow-list), like BWE staging.
3. Sign in with your BWE staging admin account (and authenticator code). You should land on the Daily Action Center
   with empty panels, and Settings should show the schedule, the $50 cap, you as owner, and the count of BWE staging leads.

No scheduled jobs exist yet, so the free Workers plan is enough for Phase 1.
