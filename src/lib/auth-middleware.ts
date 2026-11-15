import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { readServerEnv } from "./env.server";
import { claimFromJwt } from "./pin";
import { sessionHasPin } from "./pipeline/pin.server";
import { serviceClient, userClient } from "./supabase.server";

export class Unauthorized extends Error {
  constructor(message = "Please sign in again.") {
    super(`Unauthorized: ${message}`);
  }
}

async function verifiedSession() {
  const env = readServerEnv();
  const header = getRequest()?.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token.split(".").length !== 3) throw new Unauthorized();

  const supabase = userClient(env, token);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Unauthorized();
  return { env, token, supabase, userId: data.user.id, email: data.user.email ?? null };
}

/** A valid password session only. Used by the PIN step itself, which is what finishes the sign-in. */
export const requireSession = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const s = await verifiedSession();
  return next({ context: { env: s.env, supabase: s.supabase, userId: s.userId, email: s.email, sessionId: claimFromJwt(s.token, "session_id") } });
});

/**
 * Requires a valid Supabase session that has also passed the BWE PIN check. The token is verified by
 * Supabase Auth (getUser), not just decoded. A password-only session is refused here, so the PIN step
 * cannot be skipped by going straight to a page.
 */
export const requireUser = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const s = await verifiedSession();
  const db = serviceClient(s.env, s.env.GIE_DB_SCHEMA);
  if (!(await sessionHasPin(db, s.userId, claimFromJwt(s.token, "session_id")))) throw new Unauthorized("Enter your PIN to finish signing in.");
  return next({ context: { env: s.env, supabase: s.supabase, userId: s.userId, email: s.email } });
});
