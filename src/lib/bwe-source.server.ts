import type { ServerEnv } from "./env.server";
import { serviceClient } from "./supabase.server";

// Read-only access to BWE's own tables (leads, proposals, payments, ...) in the
// matching environment: staging GIE reads bwe_staging, production reads public.
// Only ever used for the tenant that IS Business Web Express, and only with
// select(): GIE never writes to BWE's schema.
export function bweReader(env: ServerEnv) {
  return serviceClient(env, env.BWE_DB_SCHEMA);
}

export type BweConnection =
  | { ok: true; schema: string; leadsTotal: number; leadsLast30Days: number }
  | { ok: false; schema: string; reason: string };

/** Confirms GIE can read BWE's leads table. Used by Settings → Data connections. */
export async function checkBweConnection(env: ServerEnv, now = new Date()): Promise<BweConnection> {
  const db = bweReader(env);
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [all, recent] = await Promise.all([
    db.from("leads").select("id", { count: "exact", head: true }),
    db.from("leads").select("id", { count: "exact", head: true }).gte("created_at", since),
  ]);
  const error = all.error ?? recent.error;
  if (error) {
    console.error("[bwe-source] leads check failed", error.message);
    return { ok: false, schema: env.BWE_DB_SCHEMA, reason: "Could not read BWE leads. Check that the schema is exposed and the service key is set." };
  }
  return { ok: true, schema: env.BWE_DB_SCHEMA, leadsTotal: all.count ?? 0, leadsLast30Days: recent.count ?? 0 };
}
