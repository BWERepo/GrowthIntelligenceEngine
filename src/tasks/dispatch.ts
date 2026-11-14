// The Worker's one cron trigger (every 15 minutes, see wrangler.jsonc). Each
// tick decides per tenant what is due, in the tenant's own time zone: overnight
// discovery (Phase 2) and the morning package (Phase 3). The end-of-day review (Phase 4) is built here too.
import { readServerEnv } from "@/lib/env.server";
import { runDiscoveryTick } from "@/lib/pipeline/discover.server";
import { runPackageTick } from "@/lib/pipeline/package.server";
import { runReplyTick } from "@/lib/pipeline/replies.server";
import { runReviewTick } from "@/lib/pipeline/review.server";

export async function dispatch(now = new Date()): Promise<void> {
  const env = readServerEnv();
  const log = [...(await runDiscoveryTick(env, now)), ...(await runPackageTick(env, now)), ...(await runReplyTick(env, now)), ...(await runReviewTick(env, now))];
  for (const entry of log) console.log(`[dispatch] ${entry.tenant} ${entry.step}: ${entry.detail}`);
}
