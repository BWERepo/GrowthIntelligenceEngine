// The Worker's one cron trigger (every 15 minutes, see wrangler.jsonc). Each
// tick decides per tenant what is due, in the tenant's own time zone. Phase 2
// runs discovery only; Phase 3 adds the morning package and Phase 4 the
// end-of-day review here.
import { readServerEnv } from "@/lib/env.server";
import { runDiscoveryTick } from "@/lib/pipeline/discover.server";

export async function dispatch(now = new Date()): Promise<void> {
  const env = readServerEnv();
  const log = await runDiscoveryTick(env, now);
  for (const entry of log) console.log(`[dispatch] ${entry.tenant} ${entry.step}: ${entry.detail}`);
}
