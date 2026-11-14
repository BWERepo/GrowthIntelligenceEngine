# Continuous improvement (Phase 7)

The app suggests, a person decides, and the app measures what followed. **It never changes a campaign or any setting**: the
only table this phase writes is `gie_recommendations`, and a test checks campaigns are untouched through the whole flow.

## Suggestions
Rule-based from recorded data (no AI writes them), hourly and idempotent, each with its evidence (label, value, source):

| Rule | Raised when |
|---|---|
| `campaign_no_replies` | active campaign at least 30 days old, 20 or more emails sent in 30 days, no replies |
| `campaign_finds_nothing` | active campaign at least 30 days old with no verified opportunities in 30 days |
| `campaign_outperforms` | a campaign (10+ emails, 3+ replies) replies at twice the rate of the others (10+ emails combined) |
| `growth_flag` | a scenario flag A to D is raised in the newest frozen 30-day report |

One open suggestion per rule and subject. A rejected or carried-out one is not raised again for 30 days.

## Decisions
Operators and owners approve or reject (proposed to approved or rejected; approved to carried out or rejected). Each is recorded
with who and when, and audited. What was suggested, its evidence, decisions, baseline and outcome can never be edited; nothing
is deleted.

## Outcome tracking
"I carried this out" stores a baseline: the rule's measure (replies, opportunities or leads) over the previous 30 days. Thirty
days later the same measure over the following 30 days is stored once, with a verdict: improved, got worse, no clear change, or
too few events to say (same rules as 30-Day Growth: 10+ events in both periods, no percent from a zero baseline). The note always
says other things changed over the same period, so it is not proof the change caused the result.

## Not built yet
AI-written explanations of suggestions, and suggestions for outreach wording or send timing.
