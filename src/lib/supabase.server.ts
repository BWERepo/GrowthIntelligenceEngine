import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "./env.server";

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** Acts as the signed-in user: every query is filtered by GIE's RLS policies. */
export function userClient(env: ServerEnv, accessToken: string): SupabaseClient<any, any, any> {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    ...noSession,
    db: { schema: env.GIE_DB_SCHEMA },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Service role: bypasses RLS. Only for server-written rows (audit, usage, job
 * runs) and read-only BWE data, always after the caller's tenant role has been
 * checked. Created per request, never shared, so no user session can leak into it.
 */
export function serviceClient(env: ServerEnv, schema: string): SupabaseClient<any, any, any> {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { ...noSession, db: { schema } });
}
