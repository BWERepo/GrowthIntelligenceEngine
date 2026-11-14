# Discovery and the Opportunity Score (Phase 2)

## Flow

```
Every 15 minutes (cron -> src/tasks/dispatch.ts), for every active workspace, in its own time zone:

02:00-06:00 on business days, once a day:
  active campaigns -> planned searches ("{location}" expanded, both signal types, daily limit)
  -> budget check -> Brave search -> usage recorded
  -> results filtered (no social/review sites, files or private addresses) and normalized
  -> gie_discovery_candidates (each page queued once per workspace, ever)

Every tick, 3 queued pages at a time:
  claim (SKIP LOCKED, so overlapping runs never take the same page)
  -> robots.txt read and obeyed, polite fetch (one request per host every 2 s, 12 s timeout, 1.5 MB cap, HTML only)
  -> already an opportunity with the same website? -> duplicate, no AI call
  -> page saved as text (gie_sources)
  -> budget check for this exact prompt -> Claude classification (no tools, structured output)
  -> answer checked in code: schema, every quote found word for word in the page, website is the page's site or linked from it
       failed -> recorded with the reason (gie_opportunity_classifications), never repaired
  -> duplicate business? -> linked to the existing opportunity
  -> Opportunity Score computed in code -> gie_opportunities + gie_opportunity_scores + components
  -> prospecting with a verified website: PageSpeed Insights (free) saved with it
```

Owners can press **Run today's search now** on Campaigns; it runs the search part only (no AI) and counts as that
day's search.

## Guarding against prompt injection

Fetched pages are untrusted. The page text goes inside one `<untrusted_page>` block that the page cannot close (any
such tag inside the page is replaced), the instructions say to ignore anything inside it, the model has no tools, and
nothing the model says is acted on without a person. An answer that repeats an injected claim still fails, because
every claim must be backed by a quote that is really in the page (see `tests/unit/classification.test.ts`).

## Opportunity Score v1 (`src/lib/scoring/opportunity.ts`)

`score = round(35 x intent + 30 x fit + 15 x freshness + 10 x reachability + 10 x evidence)`, each part from 0 to 1:

| Part | How it is worked out |
|---|---|
| Intent | Explicit request for website help 1.0, strong indirect 0.6, weak 0.3, none 0. Prospecting signals are capped at 0.3. Intent without a quote counts as none. |
| Fit | Industry in the campaign +0.4, city in the campaign area +0.3, small business +0.2, needs a new site or redesign +0.1 |
| Freshness | Published 3 days ago or less = 1, fading to 0 at the campaign's max age. Unknown date: 0 for buying intent; 1 for prospecting (the live site was checked today). |
| Reachability | Email or phone linked on the business's own site 1.0, only a contact form 0.6, none 0 |
| Evidence | Claims backed by exact quotes / claims made, times the model's confidence |

Bands: 85 and up Very high, 70 High, 50 Review, below 50 Low. Every score row keeps its rule version and all its
inputs, and a new row is written for every recalculation; score and classification rows can never be edited or
deleted. The model never gives the number.

## Costs and the cap

Before every search or AI call, the cost is estimated and checked against every budget that applies (the $50/month
total cap now). At the cap, discovery stops and the rest of the queue waits. Each call is recorded in
`gie_usage_events` (idempotent), and Campaigns shows the month's spending. With no cap set, nothing paid runs.

Rough monthly cost at the starter limits (20 searches and up to 25 new pages a business day): search $0 (Brave's
monthly credit covers it); classification with Opus 5.5 at up to about 9,000 tokens in and 1,500 out per page, about
$0.07 each, so at most about $37 for 550 pages (less in practice, because blocked pages and duplicates are never sent
to the model). The plan's 40 pages a day would be about $60 a month and would reach the cap in the third week, so the
starter campaign uses 25. Comparing Haiku 5.5 on real pages (planned) is the way to raise it.
