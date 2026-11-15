import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { readServerEnv } from "./env.server";
import { aalFromJwt, needsSecondFactor } from "./mfa";
import { serviceClient, userClient } from "./supabase.server";

export class Unauthorized extends Error {
  constructor(message = "Please sign in again.") {
    super(`Unauthorized: ${message}`);
  }
}

/**
 * Requires a valid Supabase session. The token is verified by Supabase Auth
 * (getUser), not just decoded, and the assurance level is taken from the
 * verified token so 2FA-protected admin rights work the same as in BWE.
 */
export const requireUser = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const env = readServerEnv();
  const header = getRequest()?.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token.split(".").length !== 3) throw new Unauthorized();

  const supabase = userClient(env, token);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Unauthorized();

  // An account with an authenticator must have entered its code: a password-only session is refused.
  if (aalFromJwt(token) !== "aal2") {
    const admin = serviceClient(env, env.GIE_DB_SCHEMA);
    const { data: full, error: lookupError } = await admin.auth.admin.getUserById(data.user.id);
    if (lookupError) throw new Unauthorized("Could not check your sign-in. Please try again.");
    if (needsSecondFactor(aalFromJwt(token), full.user?.factors as Array<{ factor_type?: string; status?: string }> | undefined)) {
      throw new Unauthorized("Enter your authenticator code to finish signing in.");
    }
  }

  return next({ context: { env, supabase, userId: data.user.id, email: data.user.email ?? null } });
});
