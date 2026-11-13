import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { readServerEnv } from "./env.server";
import { userClient } from "./supabase.server";

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

  return next({ context: { env, supabase, userId: data.user.id, email: data.user.email ?? null } });
});
