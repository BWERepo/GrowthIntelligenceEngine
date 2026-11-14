// Checks BWE's unsubscribe and suppression lists before a draft can be
// approved. Read-only, through bwe-source. Fails closed: if the lists cannot be
// read, or the workspace is not BWE (no lists to check yet), approval is refused.
import type { ServerEnv } from "@/lib/env.server";
import { bweReader } from "@/lib/bwe-source.server";

export type SuppressionResult = { clear: true } | { clear: false; listed: boolean; reason: string };

// Tables named in the discovery report (section 3). Column name `email` is the
// documented shape; if BWE's schema differs the query errors and approval is
// refused rather than skipped, so a wrong guess can only block, never allow.
const LISTS = [
  { table: "lead_email_unsubscribes", label: "unsubscribe list" },
  { table: "email_suppressions", label: "suppression list" },
] as const;

export async function checkSuppression(env: ServerEnv, tenantSlug: string, email: string): Promise<SuppressionResult> {
  if (tenantSlug !== env.BWE_TENANT_SLUG) {
    return { clear: false, listed: false, reason: "No unsubscribe list is connected for this workspace yet, so outreach cannot be approved." };
  }
  const db = bweReader(env);
  const address = email.trim().toLowerCase();
  for (const list of LISTS) {
    const { data, error } = await db.from(list.table).select("email").ilike("email", address).limit(1);
    if (error) {
      console.error(`[suppression] ${list.table} unreadable`, error.message);
      return { clear: false, listed: false, reason: `BWE's ${list.label} could not be read, so the draft cannot be approved.` };
    }
    if (data && data.length) return { clear: false, listed: true, reason: `${address} is on BWE's ${list.label}.` };
  }
  return { clear: true };
}
