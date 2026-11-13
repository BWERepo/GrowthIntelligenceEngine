# Growth Intelligence Engine — Phase 0 Discovery Report

**Status:** Draft for owner approval. Nothing in this report changes application code, databases or deployments.
**Date:** 2026-11-13
**Scope:** Phase 0 of the BWE Growth Intelligence Engine (BWE-GIE) specification: inspect what exists, find what can be reused, list gaps and risks, and recommend the smallest maintainable implementation.

---

## 0. Summary

1. **There is no existing Growth Intelligence Engine.** No table, route, task or document in any BWE repository mentions opportunities, opportunity scores, daily action packages, effectiveness scores or growth snapshots.
2. **A lot of the raw material already exists inside the BWE app** (`BWERepo/BWE`): inbound leads, a manual outbound prospect worksheet, a cold-email sender with mailboxes, unsubscribes and campaign counts, a Gmail IMAP reader, proposals, agreements, Stripe payments, projects, first-party site analytics with UTM fields, GA4 via GTM, a Search Console client (BWESEO) and an Anthropic SDK integration. GIE should be built **on top of these**, not beside them.
3. **Recommendation: build GIE as a new "Growth" area inside the existing BWE app** (same TanStack Start Worker, same Supabase project, same `__SCHEMA__` migration process, same staging→production pipeline). A separate Worker or app would duplicate auth, deployment, secrets and the admin shell for no benefit at this size.
4. **Multi-tenancy does not exist today.** The app has one business, two roles (`admin`, `customer`), and isolates environments by Postgres schema (`public`, `bwe_staging`, plus HDBS schemas) in **one shared Supabase project with one shared `auth.users`**. I recommend GIE be *tenant-ready* from day one (every GIE table carries `tenant_id` with RLS), with BWE as the only tenant until Phase 8. This is the main decision I need from you (section 13).
5. **Two infrastructure limits shape the design:**
   - **Cloudflare Workers Free plan**: the account is capped at 5 cron triggers across *all* projects and is already at the limit (staging's keepalive cron was dropped on 2026-10-08 to make room). Queues are not available on the Free plan. The Free plan also has a 10 ms CPU limit per invocation.
   - **Supabase free tier**: one project shared by BWE production, BWE staging and HDBS; no point-in-time recovery; 500 MB database.
   The design below works within these limits by **reusing the existing `*/15 * * * *` cron** as a dispatcher, but I recommend upgrading to **Workers Paid ($5/month)** before Phase 2 (section 13).
6. **Estimated operating cost** at BWE's current scale: roughly **$13–$95/month** depending on the AI model and search provider chosen (section 11).
7. **Estimated build effort:** about **33–46 focused working days** across Phases 1–8, with a usable Daily Action Center for BWE itself after Phases 1–3 (about 16–22 days).

---

## 1. What was inspected, and what could not be

| Source | Access | Notes |
|---|---|---|
| `BWERepo/BWE` (main app, v2026.11.13.04.11) | Full read, shallow clone of `main` | Primary target. 505 migration files, ~320 `src/lib` modules, 9 GitHub workflows. |
| `BWERepo/SEOEngine` | Full read | BWESEO engine: Search Console client, keyword/outcome tracking, index monitor. |
| `BWERepo/BlogEngine`, `BWERepo/FAQEngine` | Full read | Content engines; no prospecting functionality. Reusable patterns only (grounding, review gates). |
| `BWERepo/ClaudeConfig` | Full read | Appears to mirror `Z:\Backup\websites\Claude` (StandardPrompts.md, ClaudeInit.md, BWEInit.md, Karpathy.md, skills). |
| `BWERepo/Dashboards` (public) | Read | Local project dashboards; not related. |
| Other repos (HDBS, OneClickAnswers, client sites) | Not inspected | Not BWE platform code. HDBS shares the Supabase project, which matters for security (section 8). |
| **Live Supabase database** | **No access** | Schema, RLS and data were read from migrations only. Live drift (a migration not yet applied, e.g. the 2026-10-31 2FA migration) cannot be confirmed. |
| **Cloudflare account** | **No access** | Worker settings, plan, cron usage, KV/Queues bindings were read from `vite.config.ts`, deploy scripts and `PROJECT_STATUS.md` only. |
| **Project instructions** `Z:\Backup\websites\Claude\ProjectInstructions.md` | **Not reachable** | The cloud session cannot read your Windows drive (the device link failed to connect), and the file is not in `BWERepo/ClaudeConfig`. See section 13. |
| Google Workspace / GA4 / Search Console accounts | No access | Integration points identified from code only. |

**To verify before Phase 1** (needs you or a Remote Control session on your PC): the Cloudflare plan and current cron count, Supabase plan and database size, and whether all migrations up to `20261113120000` are applied to both schemas (`npm run migrate:check`).

---

## 2. Existing architecture (verified from code)

- **App:** TanStack Start (React 19, Vite) built with `@lovable.dev/vite-tanstack-config` and Nitro, deployed as the Cloudflare Worker `businesswebexpress`. The repo is connected to Lovable: never rewrite pushed history.
- **Server logic:** `createServerFn` functions in `src/lib/*.functions.ts`, guarded by `requireSupabaseAuth` middleware; admin functions call the `has_role(uid, 'admin')` RPC. Many queries use the service role, which bypasses RLS, so server-side checks are the real enforcement (`docs/security-hardening-2026-11.md`).
- **Database:** Supabase Postgres. Production = `public`, staging = `bwe_staging`, selected by `SUPABASE_DB_SCHEMA` / `VITE_SUPABASE_DB_SCHEMA` (`src/integrations/supabase/db-schema.ts`). Migrations are written with a `__SCHEMA__` placeholder and rendered per schema by `scripts/apply-migration.mjs`; the normal path is "render, then paste into the Supabase SQL editor".
- **Roles:** enum `app_role` = `admin | customer` in `user_roles`. Admin sign-in has TOTP 2FA (`admin-2fa`), enforced in `has_role` once enrolled.
- **Scheduling:** Nitro scheduled tasks generate the Worker's cron triggers. Production has one cron, `*/15 * * * *` → `email-log:sync` (`tasks/email-log/sync.ts`). GitHub Actions run additional scheduled jobs (`search-monitor-daily.yml` at 10:17 UTC, `search-monitor-weekly.yml`), which do not count against the Cloudflare cron cap.
- **Deploys:** `deploy-staging.yml` / `deploy-production.yml` with version checks, staging-must-match, secret-name parity and cache busting. Production needs the owner's go-ahead.
- **Tests and CI:** Vitest (`npm test`), ESLint, `pr-checks.yml`, `test.yml`. Every new public page must be in the BWESEO content inventory or `npm test` fails (GIE pages are admin-only, so this does not apply, but they must be `noindex`).
- **Observability:** Sentry with scrubbing (`sentry-scrub.ts`), production error sanitizer (`error-sanitize.ts`), KV rate limiter (`rate-limit.server.ts`).
- **UI kit:** shadcn/Radix, Tailwind 4, `recharts` 2.15 (charts), `react-hook-form`, `@dnd-kit`, `lucide-react`. Admin is a single large page (`src/routes/_authenticated/admin.tsx`, ~5,900 lines) with tabs Project, Homepage, Templates, **Leads**, Workflows, Money, **Reports**, Logs, Business, Settings, plus an alternative landing page `/admin/today` ("who is waiting on you").

---

## 3. Reusable components

| Existing piece | Where | How GIE reuses it |
|---|---|---|
| **Inbound leads** (`leads`: name, business, email, phone, message, status `new/contacted/won/lost`; anon insert with Turnstile + rate limit) | `20260721100000_leads.sql`, `src/lib/leads.functions.ts`, `NewLeadsPanel` | Inbound lead source for the funnel and for "Convert to lead". GIE links to it by id; it does not copy it. |
| **Outbound prospect worksheet** (`lead_prospects`: business type/name, city, email, date sent, received response) | `20260901050000_lead_prospects.sql`, `lead-prospects.functions.ts`, `LeadEmailManage` | Today's manual prospect list. GIE `prospects` supersede it; a one-time import maps existing rows, and the worksheet can stay until you retire it. |
| **Cold-email sending** (Blind Lead Email / Follow-up cards, SMTP mailboxes over `cloudflare:sockets`, unsubscribe link, `lead_email_unsubscribes`, `email_suppressions`, `lead_email_campaigns`) | `lead-email*.ts`, `lead-email-smtp.server.ts` | The **human-approved send path** for outreach drafts. Every GIE send goes through the existing unsubscribe/suppression filter. No new sending infrastructure. |
| **Email log + Gmail IMAP reader** (reads the BCC log copies every 15 min, read-only) | `email-log-imap.server.ts`, `tasks/email-log/sync.ts`, `email_log` | Outreach history. Extending the same reader to the lead mailbox's **inbox** gives reply detection ("replies requiring attention") without a new integration. Needs your OK (section 13). |
| **Proposals, agreements, payments, projects** (`client_proposal_sends`, `client_proposal_decisions`, `client_agreements` `pending/signed`, `payments` `deposit/balance…` with `paid_at`, `projects`, `onboardings`) | many migrations, Stripe webhook | Source of truth for **Proposal issued, Agreement accepted, Deposit, Customer, Revenue**. GIE derives funnel and revenue events from these; it does not duplicate them. |
| **Meetings** (`meetings`) | `20261107020000_meetings.sql` | Only for existing customers (`owner_id` NOT NULL references a user). Prospect meetings need their own record in GIE (see gaps). |
| **First-party site analytics** (`site_visits` with referrer, country, device, UTM source/medium/campaign, visitor id, returning flag; `site_events`) | `site-visits.functions.ts`, `site-traffic-summary.ts`, `SiteTrafficCard` | Traffic and engagement metrics for 30-Day Growth, and campaign attribution via UTM tags on outreach links. |
| **GA4 via GTM** with Consent Mode v2 | `src/lib/consent.ts`, `__root.tsx` | Optional second traffic source; would need the GA4 Data API and a service account (not built). |
| **Search Console** (`gsc_reports`; BWESEO `gsc-client.mjs` is Worker-safe; `BWESEO_GSC_SERVICE_ACCOUNT_JSON` secret in GitHub) | `seo/tools/`, `scripts/search-monitor/` | Organic search metrics. Reuse the Worker-safe client rather than writing another. |
| **Anthropic integration** (`@anthropic-ai/sdk` 1.3.0, `ANTHROPIC_API_KEY` Cloudflare secret, model `claude-opus-5-5`, grounded drafting with claim checks) | `city-page-generator.server.ts` | Pattern for the AI provider adapter, structured output and "only verified claims" checks. |
| **Verified business facts and prohibited claims** | `seo/business-profile.json`, `PRODUCT.md` | Outreach drafts must only use verified claims; the prohibited list (no ranking promises, no testimonials, no client counts, no "local" phone, never lead with AI) becomes a draft validator. |
| **Security plumbing**: `requireSupabaseAuth`, `has_role`, 2FA, KV rate limiter, encryption helper, error sanitizer, Sentry scrub | `src/lib`, `src/integrations/supabase` | Used as-is for all GIE server functions. |
| **Local-time helpers** | `src/lib/local-time.ts` | Basis for tenant-timezone scheduling. |
| **Zod** (already a dependency, used in 4 files) | `package.json` | Validation for AI output, API input and provider responses. |
| **recharts** | `package.json` | Trend charts. No new chart library. |

---

## 4. Gaps

| Gap | Impact | Plan |
|---|---|---|
| No tenants or tenant memberships; roles are global (`admin`, `customer`) | Agency clients cannot be isolated | Add `tenants`, `tenant_memberships` (roles `owner`, `operator`, `viewer`) and a `has_tenant_role()` SQL helper used by every GIE RLS policy. Existing tables untouched. |
| No unified prospect entity linking outbound and inbound | No funnel, no attribution | New `prospects` table with optional links to `leads.id`, `lead_prospects.id`, `projects.id` / customer user id. |
| No pipeline stages beyond `leads.status` (4 values) | Cannot measure meetings/proposals for prospects | `sales_funnel_events` (append-only, one row per stage reached, unique per prospect+stage) derived from GIE actions and from existing proposal/agreement/payment rows. |
| Meetings only for existing customers | Prospect meetings invisible | Record prospect meetings as funnel events with date and notes (no change to `meetings`). |
| No reply tracking | "Replies requiring attention" impossible | Extend IMAP reader to read the lead mailbox inbox (read-only), match by Message-ID/thread and sender address. |
| No discovery/search provider | No automated discovery | New provider adapter (section 6). |
| No cost/usage tracking | Budgets impossible | `usage_events` + per-tenant budgets enforced before every paid call. |
| No queue; cron cap reached | Scheduling constrained | Dispatcher on the existing 15-minute cron (section 5); Queues only after a plan upgrade. |
| Generated `types.ts` describes one schema and many newer tables are accessed with `as any` | Weak typing | GIE uses Zod row schemas at the boundary; regenerate types when convenient. |
| ~700 signed-in endpoints throw raw `error.message` (security doc) | Info leakage | GIE functions use the existing sanitizer and typed errors from the start. |

---

## 5. Recommended architecture

### 5.1 Where it lives

```
BWE Worker (businesswebexpress, TanStack Start)
├── /admin/growth                      ← Daily Action Center (default landing of Growth)
│   ├── /opportunities  /prospects  /follow-ups
│   ├── /review         (End-of-Day Review)
│   ├── /performance    (30-Day Growth Performance)
│   ├── /campaigns  /reports  /settings
├── src/lib/growth/                    ← all GIE logic, pure + testable
│   ├── scoring/opportunity.ts         (deterministic, versioned)
│   ├── scoring/effectiveness.ts       (deterministic, versioned)
│   ├── growth/rolling.ts              (30-day metrics, comparisons)
│   ├── providers/search/*.ts          (adapter interface + 1 implementation)
│   ├── providers/ai/*.ts              (adapter interface + Anthropic implementation)
│   ├── pipeline/discover.ts  classify.ts  package.ts  review.ts
│   └── *.functions.ts                 (server functions, Zod-validated)
├── tasks/growth/dispatch.ts           ← runs on the existing */15 cron
└── Supabase: new gie_* tables in public and bwe_staging (via __SCHEMA__ migrations)
```

All tables are prefixed `gie_` so they are easy to find, migrate and, if ever needed, move to a dedicated schema or project.

### 5.2 Scheduling without new cron triggers

- Register `growth:dispatch` as a second task on the **existing** `*/15 * * * *` cron (Nitro allows several tasks per cron expression). No new trigger, so the 5-trigger cap is not exceeded.
- Each run: for every active tenant, compute local time from `tenant_work_schedules.timezone` (IANA name, DST handled by `Intl`), then decide which jobs are due:
  - **Morning package** due at 08:00 local (configurable), on business days only.
  - **End-of-day review** due at 17:00 local.
  - **Discovery batch** overnight (e.g. 02:00–05:00 local), processed in small slices across several runs.
  - **Weekly/monthly reviews** on the configured weekday / first business day.
- **Idempotency:** a `gie_job_runs` row with `UNIQUE (tenant_id, job_kind, local_date)` is inserted before work starts (`INSERT … ON CONFLICT DO NOTHING`); only the inserter proceeds. Runs record `status`, `attempt`, `error`, `finished_at`. A failed run is retried on the next 15-minute tick up to a limit, then surfaces on the dashboard.
- **Missed windows:** if 08:00 is missed (outage), the next tick still generates the package and labels it "generated late".
- **Weekends/holidays:** `tenant_business_calendar` (closed dates) plus working weekdays in `tenant_work_schedules`. Non-business days produce no package and no score ("Non-business day").
- **Long AI work** never runs inside the user's request: drafts are prepared by the dispatcher and stored; the UI only reads.
- **Free-plan CPU limit (10 ms):** AI and search calls are network wait, not CPU, but JSON parsing of many results and scoring can exceed 10 ms. Work is sliced (e.g. 5 candidates per tick). This is fragile, which is the main reason to upgrade to Workers Paid (30 s CPU, Queues, higher subrequest limits).
- **Alternative for discovery:** if the Worker limits bite before an upgrade, discovery can run as a GitHub Actions scheduled workflow (the same pattern as `search-monitor-daily.yml`), writing into Supabase with the service role. Package generation and reviews stay in the Worker.

### 5.3 Data flow

```
Overnight:   discover → normalize/dedupe → classify (AI, schema-validated) → score (deterministic) → gie_opportunities
08:00:       follow-ups due + replies + carry-forward + top opportunities → rank → drafts → gie_daily_action_packages (≤5 items)
Daytime:     owner acts (Pursue/Save/Dismiss/Contacted/Convert/Complete/Block) → gie_daily_action_events (append-only)
             approved outreach → existing lead-email sender → email_log → (IMAP) replies → events
17:00:       reconcile plan vs actual → owner corrections → finalize → DES (deterministic) → AI summary (explains, never scores)
Continuous:  proposals/agreements/payments/site_visits → growth events → daily aggregates → 30-day snapshots
```

---

## 6. Database changes (proposed, nothing applied)

All tables: `uuid` primary key, `tenant_id uuid NOT NULL REFERENCES gie_tenants`, `created_at`, `updated_at`, `CHECK` constraints on every status column, RLS enabled, policies via `has_tenant_role(tenant_id, …)`, `GRANT … TO service_role`, indexes on `(tenant_id, …)` access paths. Tenant-aware foreign keys use composite `(tenant_id, id)` references so a row can never point to another tenant's row. Written with `__SCHEMA__` and applied to `public` and `bwe_staging`.

**Phase 1 — foundation**
- `gie_tenants` (name, slug, timezone, status, plan limits) — BWE seeded as tenant 1.
- `gie_tenant_memberships` (tenant_id, user_id → `auth.users`, role `owner|operator|viewer`, UNIQUE(tenant_id,user_id)). BWE platform admins (`has_role(uid,'admin')`) may manage any tenant through server functions only.
- `gie_tenant_work_schedules` (timezone, working days, morning/evening times), `gie_business_calendar` (closed dates), `gie_notification_preferences`.
- `gie_audit_events` (actor, action, entity, before/after JSON, append-only, no UPDATE/DELETE grants).
- `gie_usage_events` (provider, operation, tokens in/out, units, cost_usd estimate, model, request id), `gie_budgets` (daily/monthly limits per tenant and category).
- `gie_job_runs` (idempotency, see 5.2).

**Phase 2 — discovery and scoring**
- `gie_campaigns` (target industries, geography, queries, enabled providers, daily candidate limit, status).
- `gie_sources` (normalized URL, source type, fetched_at, content hash, robots/terms flags).
- `gie_opportunities` (campaign, source, business name, verified website URL, original source URL, discovered_at, signal type `buying_intent|prospecting`, status `new|saved|pursuing|dismissed|converted|archived`, dismiss reason, dedupe key UNIQUE per tenant).
- `gie_opportunity_classifications` (AI output JSON, schema version, model, prompt version, cost, evidence quotes, created_at) — immutable.
- `gie_opportunity_scores` + `gie_opportunity_score_components` (score, rule version, inputs snapshot) — new row on every recalculation; never updated.

**Phase 3 — daily operations**
- `gie_prospects` (business, website, contact channel, links to `leads.id`, `lead_prospects.id`, project/customer; do-not-contact flag synced with unsubscribes/suppressions).
- `gie_outreach_drafts` (prospect, channel, subject/body, follow-up draft, warnings, status `draft|approved|sent|discarded`, approved_by/at, `email_log` id once sent).
- `gie_outreach_activities`, `gie_follow_up_tasks` (due date, status, completed_at).
- `gie_daily_action_packages` (tenant, local_date, UNIQUE(tenant_id, local_date), generated_at, late flag, scoring versions used).
- `gie_daily_action_items` (package, rank, opportunity/prospect/follow-up ref, recommended action, effort, importance weight, status).
- `gie_daily_action_events` (append-only status changes with actor and reason).

**Phase 4–5 — review and effectiveness**
- `gie_end_of_day_reviews` (local_date UNIQUE per tenant, status `draft|finalized`, finalized_at, data-completeness), `gie_end_of_day_review_items`, `gie_carry_forward_decisions`.
- `gie_effectiveness_scoring_rules` (versioned JSON targets, caps, weights), `gie_daily_effectiveness_scores`, `gie_effectiveness_score_components`, `gie_effectiveness_score_events` (which events earned which points).
- `gie_ai_daily_assessments` (text, model, prompt version, inputs hash).

**Phase 6 — growth performance**
- `gie_sales_funnel_events` (prospect, stage, occurred_at, source table + source id, UNIQUE(tenant_id, prospect_id, stage)) — stages: Opportunity → Contacted → Qualified conversation → Meeting → Proposal → Agreement → Deposit → Customer.
- `gie_revenue_events` (derived from `payments` where `status='paid'`, keyed by payment id so a payment is never counted twice).
- `gie_conversion_attributions` (customer/revenue ↔ opportunity/campaign/source, model `first_touch|last_touch|assisted|unknown`, confidence).
- `gie_growth_daily_aggregates` (per tenant, day, metric, value, completeness), `gie_growth_period_snapshots` (frozen 30-day reports), `gie_campaign_performance` (view or materialized table).

**Phase 7** — `gie_recommendations` (evidence, status `proposed|approved|rejected|implemented`, implemented_at, follow-up result).

**Not duplicated:** leads, payments, proposals, agreements, projects and email log stay the source of truth. GIE stores references and derived events keyed by the source row id.

Estimated new tables: ~35 (matching the spec's list, with `gie_` prefix). Storage impact on the 500 MB free tier is small for one tenant (tens of MB per year), but evidence snippets must be size-capped.

---

## 7. Discovery and AI strategy

### 7.1 Discovery providers (authorized sources only)

Adapter interface: `search(query, options) → normalized results[]` plus `fetchPage(url)` that honours robots.txt and a per-host rate limit. Candidates for the first implementation (pricing and terms to be confirmed at setup; I have not verified current prices):
- A **web search API** (for example Brave Search API or a SERP API provider). Bing Web Search API was retired in 2025, so it is not an option.
- **RSS/Atom feeds** you choose (local business news, chamber of commerce announcements, new-business filings where published as feeds).
- **PageSpeed Insights API** (free with an API key) for verified website assessments of a prospect's existing site.
- **Your own Search Console / site_visits / GA4** for BWE's own traffic opportunities.

Explicitly **not** included: scraping private groups, Facebook/LinkedIn scraping, harvesting personal emails, bypassing logins or CAPTCHAs. Reddit and similar community APIs restrict commercial use; they stay off unless their terms are reviewed and approved.

**Important framing (from the spec and BWE's own positioning):** a weak or outdated website is a *prospecting* signal, not buying intent. The score and the UI keep these two apart (`signal_type`), and drafts for prospecting signals must not imply the owner asked for help.

### 7.2 AI classification

- One call per candidate, structured output validated by a Zod schema: `purchase_intent` (0–1 + label), `business_fit`, `freshness_days`, `reachability` (channel found on the public site or not), `evidence_quality`, `urgency`, `confidence`, `recommended_action`, and **evidence quotes that must appear verbatim in the fetched source** (checked in code; failures are rejected, never "repaired").
- Fetched pages are passed as data inside clearly delimited blocks with an instruction that their content is untrusted; the model has **no tools** during classification, so injected text cannot trigger actions. Output that fails the schema is discarded and logged.
- Record model, prompt version, timestamp, token counts and estimated cost on every call (`gie_opportunity_classifications`, `gie_usage_events`).
- Provider adapter (`AiProvider.classify / draft / summarize`) so OpenAI or another provider can be swapped in; the Anthropic implementation reuses the existing SDK and secret.

### 7.3 Model choice (your decision — affects cost)

The app already uses `claude-opus-5-5` for city pages. Current list prices per million tokens (input / output): **Opus 5.5 $4 / $20**, **Sonnet 5.5 $2 / $10**, **Haiku 5.5 $0.10 / $0.50**. My default is Opus 5.5 at low effort everywhere; using Haiku 5.5 for bulk classification would cut the AI bill by roughly 95% for that step at some quality risk. Overnight classification can also use the Batches API at 50% of the price. Section 11 shows both.

### 7.4 Outreach drafting

- Inputs: verified prospect facts, the evidence quotes, PageSpeed findings, the tenant's verified business profile and prohibited-claims list.
- Output: subject, body, suggested follow-up, channel, warnings. A code validator rejects prohibited claims, unverifiable statements, missing unsubscribe footer, and generic AI phrasing patterns.
- **Never sent automatically.** "Approve and send" uses the existing lead-email sender after an explicit click; contact-form submissions and community posts are never automated.

---

## 8. Security requirements and risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| S1 | **Staging and production share one Supabase project** (one service-role key, one `auth.users`, one storage namespace) — already flagged in `docs/security-hardening-2026-11.md` | High | Not caused by GIE, but multi-tenant client data raises the stakes. Recommend splitting staging into its own Supabase project before Phase 8 (agency clients). Until then, staging behind Cloudflare Access. |
| S2 | **HDBS shares the same Supabase project and `auth.users`** | Medium | A user who exists for HDBS is a valid authenticated user in BWE. GIE must never grant access on "authenticated" alone; every policy checks `gie_tenant_memberships`. |
| S3 | **Service-role queries bypass RLS** | High | Every GIE server function resolves the caller's tenant membership first and filters by `tenant_id` explicitly; RLS is the second layer. Cross-tenant tests cover both the RLS path (user JWT) and server functions. |
| S4 | **Prompt injection** from discovered web content | High | No tools during classification/drafting, untrusted-content delimiters, schema validation, verbatim-evidence check, no action ever taken from model output without a human click. |
| S5 | **Cold outreach compliance** (CAN-SPAM; GDPR for EU recipients) | Medium | Human approval, existing unsubscribe link and suppression lists, physical mailing address in footer (already the 300 Macedonia Lane mailing address — must not be presented as an office), business contact addresses only, no harvesting of personal emails. Optional: block EU domains by default. |
| S6 | **PII retention** (prospect names, emails, evidence snippets) | Medium | Retention setting per tenant (e.g. dismissed opportunities purged after 180 days), evidence size caps, deletion on request, Sentry scrubbing already covers emails. |
| S7 | **Runaway API spend** | Medium | Budgets checked before every paid call, per-tenant daily/monthly caps, nonessential work (discovery, drafts) suspended when exceeded, alert email via the existing `OPS_ALERT_EMAIL`. |
| S8 | **Gmail app password** used for SMTP and IMAP (`LEAD_EMAIL_SMTP_*`) | Low/Medium | Reply detection reads INBOX read-only with the same credential; consider a dedicated IMAP app password so it can be revoked separately. |
| S9 | Minor: `getLeadProspects` has no explicit admin assertion (RLS still restricts to admins) | Low | Note only; GIE replaces this read path. |

Other required controls: Zod validation on every server function, KV rate limits on mutating GIE endpoints, `gie_audit_events` for every consequential change, `noindex` on all GIE routes, secrets only as Cloudflare secrets (names in `check-secret-parity.sh`), staging first for every change.

---

## 9. Scoring and measurement methodology

The three measurements are stored in separate tables, computed by separate pure modules, versioned separately, and never combined.

### 9.1 Opportunity Score (0–100) — "How promising is this lead?"

`score = round(35·intent + 30·fit + 15·freshness + 10·reachability + 10·evidence)`, each component normalized 0–1 **in code** from the validated classification:
- **Intent**: explicit request for website help = 1.0; strong indirect signal = 0.6; prospecting-only (weak site, no request) capped at 0.3.
- **Fit**: industry in BWE's served list, small-business size, geography match, offer match (new site vs makeover).
- **Freshness**: 1.0 if ≤ 3 days, linear decay to 0 at the campaign's max age (default 60 days).
- **Reachability**: public business contact channel found on the business's own site = 1.0; only a contact form = 0.6; none = 0.
- **Evidence**: share of claims backed by verbatim quotes × classifier confidence.
Bands (configurable): 85–100 Very High, 70–84 High, 50–69 Review, < 50 Low. Every score row stores the rule version and inputs, so it is reproducible. The AI never outputs the final number.

### 9.2 Daily Effectiveness Score (0–100) — "How meaningful was today's work?"

Deterministic from `gie_daily_action_events`, funnel events and follow-up tasks for that local date; rule set stored in `gie_effectiveness_scoring_rules` (versioned):
- **Business Outcomes (40):** points per event type with diminishing returns, e.g. qualified conversation 8 (cap 16), meeting 12 (cap 24), proposal 12, agreement/customer 20, revenue on a log scale; capped at 40; each event counted once (unique source id).
- **Action Quality (25):** share of contacts that were (a) to verified prospects, (b) evidence-based drafts that passed the validator, (c) edited/personalized before approval, (d) not duplicates — weighted average × 25.
- **Follow-Up Discipline (15):** due follow-ups completed on time / due follow-ups; replies handled within one business day; "awaiting external response" items excluded from the denominator.
- **Priority Execution (10):** Σ importance of completed planned items / Σ importance of planned items.
- **Opportunity Management (10):** reviews and dismissals with reasons of items in the package, capped so admin activity alone cannot exceed 10.
- **Missing data:** if the package was never opened, tracking failed, or the day is non-business, the score is **"Score unavailable — insufficient verified activity data"** (with the reason), not 0. A provisional score shows a completeness percentage until the review is finalized.
- **Delayed outcomes:** an outcome counts on its actual occurrence date and links back to the original action; finalized historical scores are never rewritten.
Bands: 90+ Exceptional, 75–89 Highly Effective, 60–74 Productive, 40–59 Needs Improvement, < 40 Low (operational heuristics, labelled as such).

### 9.3 30-Day Growth Performance — "Is the business actually growing?" (primary)

- Window: current rolling 30 days ending yesterday (tenant local dates) vs the preceding 30 days.
- Metrics: verified opportunities, pursued, qualified leads (inbound `leads` + prospects reaching "qualified conversation"), meetings, proposals issued (`client_proposal_sends`), agreements signed (`client_agreements.status='signed'`), deposits (`payments.kind='deposit'`, paid), new customers (first paid payment per customer), attributable revenue (paid payments linked to a GIE prospect), conversion rates between stages, cost per qualified lead (`gie_usage_events` + entered campaign costs), CAC, visitors / organic / referral / engaged sessions / conversions (`site_visits`, GSC).
- For each metric: current, previous, absolute change, % change **only when previous > 0** (otherwise "n/a — no baseline"), direction, completeness, source.
- **Small samples:** below a configurable minimum (default: fewer than 10 events in either period) the UI shows counts only, labels the trend "insufficient evidence", and the health assessment says so.
- **Event-date vs cohort:** both views — "customers won in the last 30 days" and "conversion of leads first discovered in the window".
- **Attribution:** first touch, last touch, assisted, unknown; confidence high only when a direct link exists (prospect id on the proposal/customer, or UTM campaign on the visit that led to the lead).
- **Scenario detection (A–D in the spec):** rule-based flags comparing DES trend, opportunity-score averages, funnel conversion and traffic vs revenue; the AI assessment explains the flags, it does not invent them.

---

## 10. Workflows and dashboard

**Daily workflow (08:00 local):** reconcile overnight discoveries → collect follow-ups due, replies, carry-forwards, saved items → drop duplicates/dismissed/do-not-contact → re-check stale opportunities (re-score if new evidence) → rank by `score × urgency × effort` with follow-ups due ranked first → prepare drafts for the top items only (cost control) → save package → optional email to the owner. Up to five actions; fewer when fewer verified items exist. Actions: Pursue, Save, Dismiss (reason), Mark contacted (method/date/outcome), Convert to lead (creates/links `leads` row with attribution), Mark complete, Block/Reschedule — each an append-only event.

**End-of-day workflow (17:00 local):** build plan-vs-actual with statuses (not started, in progress, completed, deferred, blocked, awaiting response, cancelled) → owner corrects missing activity → recommended disposition for each unfinished item (carry forward, reschedule, lower priority, block, archive, dismiss; items carried forward 3 times are flagged as stale instead of recycled) → owner finalizes → DES computed → AI assessment written from recorded facts only → tomorrow's provisional plan stored and reconciled at 08:00.

**Dashboard hierarchy (desktop and iPad):**
1. **Top — 30-Day Growth Performance:** qualified leads, meetings, proposals, new customers, attributable revenue, conversion rate, cost per qualified lead, each with previous-period comparison and a rolling 30-day line chart (recharts). Largest visual weight.
2. **Middle — Today's Priority Actions:** up to five cards with name, verified site, source link, discovery time, evidence, Opportunity Score chip with breakdown on hover, recommended action, effort, draft, follow-up.
3. **Supporting — Daily Effectiveness:** today's provisional/final score, component bars, completeness indicator. Smaller than the growth panel by design.
4. Opportunity Scores appear only on opportunity and prospect cards.
Empty states say what is missing ("No verified opportunities yet — discovery runs overnight"), never placeholder numbers. Navigation: a "Growth" entry in the admin nav opens the Daily Action Center; the existing Leads tab cards keep working.

---

## 11. Operating costs (estimates, one tenant, ~22 business days/month)

Assumptions: 40 candidates classified per night (~4,000 input + 600 output tokens each including reasoning), 5 drafts/day (~6,000 in + 1,500 out), 1 end-of-day assessment/day (~8,000 in + 1,500 out), weekly/monthly summaries negligible.

| Item | Opus 5.5 everywhere | Haiku 5.5 for classification, Opus 5.5 for drafts/summaries |
|---|---:|---:|
| Classification (~880 calls) | ~$25 (≈$12 with Batches) | ~$0.60 |
| Drafts (~110) | ~$6 | ~$6 |
| Daily assessments (~22) | ~$1.40 | ~$1.40 |
| **AI subtotal** | **~$20–33** | **~$8** |
| Search API (~1,000–3,000 queries) | $0–$30 depending on provider/tier (to confirm) | same |
| PageSpeed Insights | $0 | $0 |
| Cloudflare Workers Paid (recommended) | $5 | $5 |
| Supabase | $0 now; $25 if you move to Pro for backups/staging split | same |
| **Total** | **~$25–$95/month** | **~$13–$70/month** |

Budgets default to a hard monthly cap you choose (suggest $50) with alerts at 50% and 80%.

---

## 12. Development phases and effort

Effort is in focused working days and includes tests and staging deploys; your review time is not included. Each phase ends at staging and waits for your approval before production and before the next phase.

| Phase | Scope | Est. days | Key tests |
|---|---|---:|---|
| 1 Multi-tenant foundation | `gie_tenants`, memberships, `has_tenant_role`, schedules, audit, usage, budgets, job runs; BWE tenant seed; Growth nav shell with empty states; dispatcher task wired to existing cron | 4–6 | RLS cross-tenant suite (two tenants, user JWTs), server-function tenant checks, idempotent job claim, DST transitions |
| 2 Discovery and scoring | campaigns, search + PageSpeed adapters, robots-aware fetch, dedupe, AI classification with Zod + verbatim evidence check, Opportunity Score v1, cost tracking | 6–8 | scoring golden tests, schema rejection, injection fixtures, dedupe, budget stop |
| 3 Daily Action Center | prospects (+ import from `lead_prospects`), packages, ranking, drafts + validator, approval → existing sender, follow-ups, actions/events, reply detection via IMAP | 6–8 | one package per local date, ≤5 items, duplicate-outreach prevention, unsubscribe filter, approval required |
| 4 End-of-Day Review | reconciliation, corrections, carry-forward rules, AI assessment, tomorrow's plan | 3–4 | no duplicate carry-forward, stale detection, finalize locks |
| 5 Daily Effectiveness Score | rule set v1, components, evidence, missing-data states, history | 3–4 | determinism, caps, "unavailable" vs zero, no historical rewrite |
| 6 30-Day Growth | funnel events from existing tables, revenue events, attribution, aggregates, snapshots, dashboard and charts, scenario flags | 5–7 | zero-baseline %, no double counting, cohort vs event date, small-sample flags |
| 7 Continuous improvement | recommendations with evidence, approval, outcome tracking | 2–3 | no automatic campaign changes |
| 8 Agency readiness | client tenant onboarding, per-tenant reports, quotas, monitoring; staging Supabase split recommended first | 4–6 | full cross-tenant penetration checklist |
| **Total** | | **33–46** | |

The spec's 24 deliverables map onto these phases; the system diagram, ERD, API specification and admin documentation are produced as Markdown in `docs/growth-intelligence/` during Phases 1–2.

---

## 13. Decisions and access needed from you

1. **Tenancy now or later.** Recommended: tenant-ready tables with BWE as the only tenant until Phase 8. Alternative: full agency onboarding from Phase 1 (adds ~4–6 days earlier and makes the shared-Supabase risk S1 urgent).
2. **Cloudflare plan.** Recommended: Workers Paid ($5/month) before Phase 2, for CPU time and Queues. Without it, I will use the existing 15-minute cron with sliced work and, if needed, GitHub Actions for discovery. Please also confirm the current cron count.
3. **AI model.** Opus 5.5 everywhere (simplest, ~$20–33/month AI) or Haiku 5.5 for bulk classification (~$8/month AI).
4. **Search provider and monthly budget cap.** Which web search API (I can compare 2–3 with current prices in Phase 2) and the hard monthly cap (suggest $50).
5. **Reply detection.** OK to read the lead mailbox INBOX read-only over IMAP (same approach as the existing email-log sync)?
6. **Discovery targets.** Industries, geography (Knoxville/Tennessee first?), and whether both "buying-intent" and "prospecting" opportunities should be discovered from the start.
7. **Project instructions file.** `Z:\Backup\websites\Claude\ProjectInstructions.md` could not be read from the cloud and is not in `BWERepo/ClaudeConfig`. If it contains rules for this project, please add it to that repo (or paste it into the thread). The repo's own `StandardPrompts.md` ("ask questions until 100% certain", "always deploy to staging and bump the patch version", "check your work") will be followed in Phases 1+.
8. **Approval to start Phase 1.** Nothing has been changed; Phase 1 creates migrations (to be applied by you via the SQL editor, staging schema first) and the Growth nav shell, deployed to staging only.

---

## 14. Decisions recorded (2026-11-13)

| # | Question | Owner's decision |
|---|---|---|
| 1 | Multi-tenancy | **Tenant-ready, BWE only for now.** Every GIE table carries `tenant_id` with RLS; client onboarding waits for Phase 8. |
| 2 | Cloudflare plan | **Upgrade to Workers Paid before Phase 2.** Phase 1 runs on the free plan using the existing 15-minute cron. |
| 3 | AI model | **Start with Opus 5.5 everywhere; in Phase 2 compare Haiku 5.5 on real prospects** and switch classification only if quality holds. |
| 4 | Search provider | **Claude compares 2–3 providers in Phase 2** (current prices and terms) and recommends one before any signup. |
| 5 | Spending cap | **$50/month hard cap** on AI + search; alerts at $25 and $40; at the cap, discovery and drafts pause, daily actions and follow-ups keep working. |
| 6 | Reply detection | **Yes, read-only IMAP on the lead mailbox INBOX, reusing the existing lead mailbox credential** (`LEAD_EMAIL_SMTP_*` / `EMAIL_LOG_IMAP_*`). Nothing is marked read, moved or deleted. |
| 7 | Discovery targets | **East Tennessee first** (Knoxville, Chattanooga and nearby) **in BWE's served industries** (HVAC, dental, restaurants, home services, legal, nonprofits and the other industries in the questionnaire list), **both buying-intent and prospecting signals**, kept separate in scoring. |
| 8 | Project instructions | **Owner will add `ProjectInstructions.md` to `BWERepo/ClaudeConfig`.** Read it before starting Phase 1. |

Still pending: the owner's explicit approval to start Phase 1.
