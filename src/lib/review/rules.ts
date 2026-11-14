// End-of-day rules (plan section 10). Pure: what to recommend for an unfinished
// item, what a person may choose, and the check that an AI assessment states only
// numbers that are in the recorded facts.
import { STALE_AFTER_CARRIES } from "@/lib/actions/ranking";

export type ItemStatus = "not_started" | "in_progress" | "completed" | "deferred" | "blocked" | "awaiting_response" | "cancelled";
export type Disposition = "none" | "carry_forward" | "reschedule" | "lower_priority" | "block" | "archive" | "dismiss";
export type ItemKind = "follow_up" | "opportunity";

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  none: "Nothing to decide",
  carry_forward: "Carry forward to tomorrow",
  reschedule: "Reschedule to a date",
  lower_priority: "Lower its priority",
  block: "Block until a date",
  archive: "Archive",
  dismiss: "Dismiss",
};

/** Finished, handed off, or called off: nothing is left to decide. */
export function isSettled(status: ItemStatus): boolean {
  return status === "completed" || status === "awaiting_response" || status === "cancelled";
}

export type ReviewFacts = { kind: ItemKind; status: ItemStatus; timesUnfinishedBefore: number };

/** How many packages this item has now been left unfinished in, today's included. */
export function unfinishedCount(f: ReviewFacts): number {
  return f.timesUnfinishedBefore + (isSettled(f.status) ? 0 : 1);
}

export function isStale(f: ReviewFacts): boolean {
  return !isSettled(f.status) && unfinishedCount(f) >= STALE_AFTER_CARRIES;
}

/** What the person may choose for this item. */
export function allowedDispositions(f: ReviewFacts): Disposition[] {
  if (isSettled(f.status)) return ["none"];
  return f.kind === "opportunity"
    ? ["carry_forward", "reschedule", "lower_priority", "block", "archive", "dismiss"]
    : ["carry_forward", "reschedule", "dismiss", "archive"];
}

/** The default recommendation. An item left unfinished three times is flagged stale, not recycled. */
export function recommendDisposition(f: ReviewFacts): { disposition: Disposition; stale: boolean; suggestDays: number | null } {
  if (isSettled(f.status)) return { disposition: "none", stale: false, suggestDays: null };
  if (isStale(f)) return { disposition: "archive", stale: true, suggestDays: null };
  if (f.status === "blocked") return f.kind === "opportunity" ? { disposition: "block", stale: false, suggestDays: 14 } : { disposition: "reschedule", stale: false, suggestDays: 3 };
  if (f.status === "deferred") return { disposition: "reschedule", stale: false, suggestDays: 3 };
  return { disposition: "carry_forward", stale: false, suggestDays: null };
}

export function needsDate(d: Disposition): boolean {
  return d === "reschedule" || d === "block";
}

/** Checks a person's choice against the rules. Returns the problem, or null when it is fine. */
export function checkChoice(f: ReviewFacts, d: Disposition | null, date: string | null, note: string | null, today: string): string | null {
  if (!d) return "Choose what happens to this item.";
  if (!allowedDispositions(f).includes(d)) return `"${DISPOSITION_LABEL[d]}" is not available for this item.`;
  if (needsDate(d)) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Pick a date.";
    if (date <= today) return "The date must be after today.";
  }
  if (d === "dismiss" && !(note ?? "").trim()) return "Give a short reason for dismissing.";
  return null;
}

/** Plain, reproducible fingerprint of the facts an assessment was written from. */
export async function hashFacts(facts: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(facts));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every digit-number written in the text must be one of the recorded numbers. Returns the ones that are not. */
export function ungroundedNumbers(text: string, facts: unknown): string[] {
  const allowed = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "number") allowed.add(String(v));
    else if (typeof v === "string") for (const m of v.match(/\d+(\.\d+)?/g) ?? []) allowed.add(m);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(facts);
  const found = text.match(/\d+(\.\d+)?/g) ?? [];
  return [...new Set(found.filter((n) => !allowed.has(n)))];
}
