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

Phase 1 alone has no scheduled jobs. Phase 2 adds one (section 5).

## 5. Phase 2: discovery and scoring

Do these in order. Each step can be checked before the next.

1. **Workers Paid.** Cloudflare → Workers & Pages → Plans → upgrade to Workers Paid ($5/month). Phase 2 adds a
   15-minute cron trigger to this Worker, and the free plan is already at its 5-trigger limit, so the deploy fails
   without the upgrade.
2. **Database.** Render and run the Phase 2 migration on staging, exactly like step 1:
   `npm run migrate:render -- supabase/migrations/20261114120000_gie_discovery.sql --split`, then paste the
   **staging** file into the SQL editor. Check: `select name, status from gie_staging.gie_campaigns;` returns one
   row, *East Tennessee small businesses*, status `draft`.
3. **Keys** (Worker secrets; the values never go in the repository):

   ```
   npx wrangler secret put ANTHROPIC_API_KEY --env staging      # Claude API key (classification)
   npx wrangler secret put BRAVE_SEARCH_API_KEY --env staging   # Brave Search API, "Search" plan
   npx wrangler secret put PAGESPEED_API_KEY --env staging      # Google PageSpeed Insights (free; optional)
   ```

   Brave: sign up at brave.com/search/api, choose the **Search** plan and
   create a key. PageSpeed: Google Cloud console → enable *PageSpeed Insights API* →
   Credentials → API key (restrict it to that API). Without a key, that step is skipped and Campaigns says which
   key is missing.
4. **Deploy staging** (Actions → Deploy staging).
5. **Turn it on.** Campaigns → review the starter campaign's industries, places and searches → set it to *Active* →
   Save. As owner, *Run today's search now* searches immediately (no AI cost); the cron then classifies about 3
   pages every 15 minutes (roughly 12 an hour) until the queue is empty or the cap is reached.
6. **Check.** Campaigns shows the queue counts and the month's spending; Opportunities lists what was found, each
   with its source page, the exact quotes, and the score breakdown.

The classification model is the `GIE_CLASSIFY_MODEL` variable in `wrangler.jsonc` (`claude-opus-5-5` now; the
Haiku 5.5 comparison is a later step on real pages).

## 6. Phase 3: Daily Action Center (first slice)

1. **Database.** Render and run the Phase 3 migration on staging after the Phase 2 one:
   `npm run migrate:render -- supabase/migrations/20261115120000_gie_daily_actions.sql --split`, paste the
   **staging** file into the SQL editor. No new keys or Worker settings are needed.
2. **Deploy staging**, then open the Daily Action Center. The morning package is built by the existing cron once the
   local time passes the morning window, or as owner press *Build today's actions now*.
3. **Check the unsubscribe lists.** Approval reads BWE's `lead_email_unsubscribes` and `email_suppressions` tables
   by an `email` column. If those names differ on staging, approval is refused (it fails closed); tell me what the
   tables look like and I will fix the query.
4. **Sending and replies come in section 7.**

## 7. Phase 3, second slice: sending and replies

GIE sends approved outreach through BWE's own lead mailbox and reads that mailbox's INBOX (read-only) for replies.
It reuses BWE's unsubscribe page and lists, so there is no new sending service.

1. **Database.** Render and run `supabase/migrations/20261116120000_gie_outreach_send.sql` on staging.
2. **Worker secrets** (staging first). Use the same values BWE uses; the values never go in the repository:

   ```
   npx wrangler secret put LEAD_EMAIL_SMTP_USER --env staging       # the lead mailbox address
   npx wrangler secret put LEAD_EMAIL_SMTP_PASSWORD --env staging   # its Google app password (works for IMAP too)
   npx wrangler secret put UNSUBSCRIBE_SECRET --env staging         # must equal BWE's, or its unsubscribe page rejects our links
   ```

   Optional: `LEAD_EMAIL_SMTP_HOST` (default smtp.gmail.com), `LEAD_EMAIL_SMTP_PORT` (465), `LEAD_EMAIL_IMAP_HOST`
   (smtp. replaced by imap.), `EMAIL_LOG_IMAP_USER` / `EMAIL_LOG_IMAP_PASSWORD` (a separate login for reading replies),
   `UNSUBSCRIBE_BASE_URL` (default https://businesswebexpress.com), `GIE_DAILY_SEND_CAP` (default 20 sent emails a day).
3. **BWE's mailing address** is read from BWE's business settings (the mailing address, never the physical one). If it is
   empty, nothing is sent.
4. **Check on staging with your own address first:** make a prospect whose email is yours, approve, press *Send now*,
   click the unsubscribe link in the email (BWE's page should confirm), reply to it, and within 15 minutes the reply
   appears under *Replies to your outreach*.

What happens: *Send now* is a separate click after approval. It re-runs the validator and the unsubscribe and suppression
check, stops at the daily cap, sends once (a double click cannot send twice), BCCs BWE's `+log` address so BWE's email
log keeps its record, and schedules a 7-day follow-up reminder. A reply stops that reminder; a bounce marks the address
do-not-contact.

## 8. Phase 4: End-of-Day Review

1. **Database.** Render and run `supabase/migrations/20261117120000_gie_end_of_day.sql` on staging after the Phase 3
   migrations. It adds three tables and hold/priority columns on opportunities.
2. **Deploy staging.** No new keys. The existing cron builds each business day's review at the evening time (Settings shows
   it); as owner you can press *Build today's review now* on the End-of-Day Review page.
3. **Try it:** correct a status, choose a decision for each unfinished item, press *Finalize*. The note on the day appears
   within about 15 minutes (it needs `ANTHROPIC_API_KEY`; without it the review still works and says the note is not written).

## 9. Phase 5: Daily Effectiveness Score

1. **Database.** Render and run `supabase/migrations/20261118120000_gie_effectiveness.sql` on staging after the Phase 4 one.
   It adds the score tables, stores the first rule set (`des-v1`) for each existing workspace, and starts stamping when a
   reply is marked handled. No new keys.
2. **Check.** The Daily Action Center's small *Daily Effectiveness* panel shows today's provisional score or why it is
   unavailable. Finalize an end-of-day review; within about 15 minutes that day's final score is stored and appears on the
   End-of-Day Review page. Rules and scoring: `docs/growth-intelligence/effectiveness-score.md`.

## 10. Phase 6: 30-Day Growth Performance

1. **Database.** Render and run `supabase/migrations/20261119120000_gie_growth.sql` on staging after the Phase 5 one. It adds
   the outcome tables (funnel events, revenue events) and the frozen daily report table. No new keys.
2. **Check.** Within about an hour of the next cron tick the Worker records outcomes. The Daily Action Center's top panel and
   the Growth Performance page then show the last 30 days against the 30 before. In the BWE workspace the panel reads BWE's
   leads, meetings, proposals, agreements, payments and site visits (read only); other workspaces show their own outreach
   only and say the rest is not connected. After 06:00 local time one report per day is frozen. Details:
   `docs/growth-intelligence/growth-performance.md`.

## 11. Phase 7: Continuous improvement

1. **Database.** Render and run `supabase/migrations/20261120120000_gie_recommendations.sql` on staging after the Phase 6 one. No new keys.
2. **Check.** The Improvements page lists suggestions once recorded results support one. Details: `docs/growth-intelligence/improvements.md`.

## 12. Phase 8: Agency readiness

1. **Database.** Render and run `supabase/migrations/20261121120000_gie_agency.sql` on staging after the Phase 7 one. It makes
   suspension work in the database, and adds per-workspace limits. No new keys.
2. **Before any real client:** split staging into its own Supabase project and settle the questions in
   `docs/growth-intelligence/agency-readiness.md`. Then create the first client workspace on the Workspaces page.
