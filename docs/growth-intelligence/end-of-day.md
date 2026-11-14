# End-of-Day Review (Phase 4)

**Build.** On each business day at the workspace's evening time (default 17:00, built late and labelled if missed) the cron
builds one review per local date from that day's action package. Each item shows the status the record had, how many
earlier packages it was left unfinished in, and a recommendation. No package means a review that says nothing was planned.

**Recommendations** (`src/lib/review/rules.ts`): finished, handed-off or cancelled items need no decision. Unfinished items
are carried forward; deferred items are rescheduled; blocked items are blocked until a date. An item left unfinished a third
time is flagged **stale** and recommended for archive instead of being recycled (the ranking already stops offering it).

**Corrections and decisions.** An operator sets what actually happened (for example, "completed" for work done by phone) and
chooses what happens to each unfinished item: carry forward, reschedule or block to a date, lower priority (halves its
ranking weight), archive, or dismiss with a reason. Follow-ups may be carried, rescheduled, archived or dismissed.

**Finalize** (owner only). Every choice is checked first; nothing changes until all are acceptable. Then the server applies
the decisions once (an `applied_at` mark and a claim stop a double click from repeating them), records corrected statuses and
decisions in the append-only action log, stores a provisional plan for the next business day, and locks the review. A
finalized review, its items and its assessment can never be changed, in the database as well as the app. The morning package
rebuilds the plan from fresh data, so it may differ.

**Assessment.** After finalizing, the cron writes a short note from a JSON record of the day's facts (counts, statuses,
decisions, emails sent, replies, follow-ups done). The model is told to use only those facts and to write counts as digits;
the server then rejects any note containing a number that is not in the record, tries at most three times, checks the
$50 budget first, and records the spend. It is a summary, not a score: the Daily Effectiveness Score is Phase 5.
