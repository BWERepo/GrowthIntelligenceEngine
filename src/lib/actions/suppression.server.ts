// Checks BWE's unsubscribe and suppression lists before a draft can be
// approved. Read-only, through bwe-source. Fails closed: if the lists cannot be
// read, or the workspace is not BWE (no lists to check yet), approval is refused.
import type { ServerEnv } from "@/lib/env.server";
import { bweReader } from "@/lib/bwe-source.server";

export type SuppressionResult = { clear: true } | { clear: false; listed: boolean; reason: string };

// BWE's two lists, as defined in its migrations: lead_email_unsubscribes(kind, email,
// stored lowercase) and email_suppressions(email_normalized). Any read error
// refuses approval rather than skipping the check.
const LISTS = [
  { table: "lead_email_unsubscribes", column: "email", label: "unsubscribe list" },
  { table: "email_suppressions", column: "email_normalized", label: "suppression list" },
] as const;

export async function checkSuppression(env: ServerEnv, tenantSlug: string, email: string): Promise<SuppressionResult> {
  if (tenantSlug !== env.BWE_TENANT_SLUG) {
    return { clear: false, listed: false, reason: "No unsubscribe list is connected for this workspace yet, so outreach cannot be approved." };
  }
  const db = bweReader(env);
  const address = email.trim().toLowerCase();
  for (const list of LISTS) {
    const { data, error } = await db.from(list.table).select(list.column).eq(list.column, address).limit(1);
    if (error) {
      console.error(`[suppression] ${list.table} unreadable`, error.message);
      return { clear: false, listed: false, reason: `BWE's ${list.label} could not be read, so the draft cannot be approved.` };
    }
    if (data && data.length) return { clear: false, listed: true, reason: `${address} is on BWE's ${list.label}.` };
  }
  return { clear: true };
}
