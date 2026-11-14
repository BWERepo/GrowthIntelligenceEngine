# Daily Effectiveness Score (Phase 5)

"How meaningful was today's work?" It is one of three separate measurements and is never combined with the Opportunity Score
or the 30-Day Growth panel (which stays the most prominent on the Daily Action Center).

**Rules: `des-v1`** (`src/lib/scoring/effectiveness.ts`, stored per workspace in `gie_effectiveness_scoring_rules`; a change is
a new version, never an edit). The score is computed in code from recorded facts; the AI never produces it.

| Component | Weight | What is measured |
|---|---|---|
| Business outcomes | 40 | **Not measured yet.** Meetings, proposals, customers and revenue are tracked from Phase 6 (a later rule version will use them). |
| Action quality | 25 | Each email sent that day: verified prospect (25%), draft passed the validator (35%), edited by a person (20%), not a repeat contact within 30 days (20%). Average over the day's emails. |
| Follow-up discipline | 15 | Follow-ups due that day done by the end of it, plus replies from the previous business day handled by the end of the day. Follow-ups waiting on someone else's answer and cancelled ones are left out. |
| Priority execution | 10 | Importance of completed planned actions over importance of all planned actions. |
| Opportunity management | 10 | Share of the package's opportunities that were worked, or decided at the review with a reason or date (carrying forward is not a decision). |

**Missing data.** A component with nothing to measure (for example, no emails sent) is left out, not scored zero. The score is
the earned points over the measured weight, shown with its **completeness** (percent of the 100 points that could be measured).
Below 50% completeness, or with no action package, the score is **"Score unavailable"** with the reason, and that is stored as
unavailable, never as 0. Today this means business outcomes (40) are never measured, so a day needs a measurable share of the
other 60 points to show a score.

**Bands** (operational heuristics, labelled as such): 90+ Exceptional, 75-89 Highly Effective, 60-74 Productive, 40-59 Needs
Improvement, below 40 Low.

**Provisional and final.** Until the end-of-day review is finalized the score is provisional: computed when asked from what is
recorded so far, with its completeness, and not stored. After finalizing, the cron stores it once (the day, the exact rules,
each component, and the recorded events that earned each point). Stored scores, components and evidence cannot be changed or
deleted, in the database as well as the app, so history is never rewritten. A late outcome counts on the day it actually
happened, not on the day it relates to.

**Screens.** The supporting panel on the Daily Action Center shows today's provisional score; the End-of-Day Review page shows
any day's components, what earned the points, and the last 14 days. Non-business days show "no score".
