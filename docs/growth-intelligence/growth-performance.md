# 30-Day Growth Performance (Phase 6)

The primary measurement: *is the business actually growing?* It is separate from the Opportunity Score and the Daily
Effectiveness Score and is never combined with them.

## Window
The last 30 tenant-local days ending **yesterday**, against the 30 days before. Events are placed on their tenant-local date.
(A BWE meeting has a date but no time; it is placed at noon UTC, which is the same date in US time zones.)

## What is recorded
`syncOutcomes` runs hourly from the existing cron and records each fact once, keyed by its source row (unique per workspace,
stage, source table and source id), so running it twice never counts twice. It looks back 90 days.

| Stage | Source | Workspaces |
|---|---|---|
| Verified opportunities | `gie_opportunities.discovered_at` | all |
| Pursued | `gie_prospects.created_at` | all |
| Contacted | sent `gie_outreach_drafts` | all |
| Replies received | `gie_outreach_replies` of kind reply (bounces and auto-replies excluded) | all |
| Leads | BWE `leads` | BWE only |
| Meetings | BWE `meetings` | BWE only |
| Proposals sent | BWE `client_proposal_sends` | BWE only |
| Agreements signed | BWE `client_agreements` with status signed | BWE only |
| Deposits paid | BWE `payments` with kind deposit, status paid | BWE only |
| New customers | first paid payment per BWE customer, counted once | BWE only |
| Revenue | BWE paid payments in USD (other currencies are counted and mentioned, never added in) | BWE only |

Other workspaces show BWE-sourced rows as "Not connected", never as zero. A reply is not called a "qualified conversation":
that needs a person's judgement and is not built yet.

## Rules
- **Percent change** only when the previous period is above zero. Otherwise "n/a: no baseline".
- **Small samples:** fewer than 10 events in either period shows counts only and "Insufficient evidence". Revenue is judged by
  its number of payments, not its dollars. (The minimum is a constant, `MIN_EVENTS`, not a setting yet.)
- **Two views:** event-date (what happened in the window) and a cohort view (of prospects first pursued in the window, how far
  they have since got, on any date).
- **Attribution** (stored with its basis): *high* only with a stored id link (a lead linked to a prospect); *medium* when an
  email address matches (a customer's onboarding email to a linked lead or to a prospect's email; an email matching two
  prospects links to none); otherwise *unknown*, shown separately. *First touch* means we emailed before they first appeared
  in BWE's records; *assisted* means they were already there (or we never emailed). *Last touch* needs touch history from
  other channels and is not derived.
- **Scenario flags** are rule-based and need enough evidence: A more outreach but no more results; B results up without more
  outreach; C more site visits but no more leads; D high Daily Effectiveness average (75+ over 5+ scored days) while results
  fall. They only describe; the spec's own A-D wording was not in the repository, so these are named by what they check.
- **Frozen reports:** after 06:00 local time one report per day is stored and never rewritten. Outcomes cannot be edited
  once recorded (only a later-found attribution link can refresh); nothing is deleted.

## Not built yet
Cost per qualified lead and CAC (no entered campaign costs), Search Console data, a saved AI explanation of the flags, and a
`des-v2` rule set that scores business outcomes in the Daily Effectiveness Score (business outcomes stay "not measured" there).
Bars on the page are plain CSS; no chart library was added.
