# Daily actions (Phase 3, first slice)

**Package.** Once per workspace per local day the cron builds up to five actions. Due follow-ups come first (most
overdue first), then opportunities by `score x urgency / effort` (`ranking-v1`); a pursuing opportunity gets +8.
Fewer than five is normal when fewer verified items exist. Opportunities carried three times without action are
left out rather than recycled. The three measurements stay separate: the 30-day panel is first on the screen.

**Drafts.** For the top opportunities that have a public email, Claude drafts a short message (budget checked first,
usage recorded). The validator then blocks approval for: missing unsubscribe or mailing-address line, guarantees,
ranking promises, client counts, testimonials, leading with AI, pressure language, local claims, a fake "Re:", and
implying a prospecting signal asked for help. It warns about generic phrasing, unknown links and unverified numbers.

**Approval.** Only a person approves, only on the server. It re-validates, checks do-not-contact, and checks BWE's
unsubscribe and suppression lists (fails closed). Approval is recorded with who and when. It does not send.

**Records.** Action events are append-only. Drafts, packages and items are written by the server; operators can
reword a draft, change an action's status, and schedule or finish follow-ups.

**Sending.** A separate *Send now* click on an approved draft. The server re-validates, re-checks do-not-contact and
BWE's unsubscribe and suppression lists, applies the daily cap, fills the unsubscribe link (BWE's signed token) and
BWE's mailing address, and claims the draft (`approved` to `sent`) before opening the mail connection, so it cannot send
twice. If the mail server refuses, the draft returns to `approved` with the reason. Nothing sends if the mailbox login,
`UNSUBSCRIBE_SECRET` or the mailing address is missing.

**Replies.** Every 15 minutes the cron reads the lead mailbox INBOX read-only (`EXAMINE`, `BODY.PEEK`: nothing is marked
read, moved or deleted), matches mail from addresses we sent to in the last 30 days, and records it once by Message-ID with
a short snippet. Automatic replies are labelled; a bounce marks the prospect do-not-contact; a real reply cancels the
open follow-up reminder.
