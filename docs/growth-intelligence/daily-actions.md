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
unsubscribe and suppression lists (fails closed). Approval is recorded with who and when; nothing is sent yet.

**Records.** Action events are append-only. Drafts, packages and items are written by the server; operators can
reword a draft, change an action's status, and schedule or finish follow-ups.
