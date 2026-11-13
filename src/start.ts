import { createMiddleware, createStart } from "@tanstack/react-start";
import { currentAccessToken } from "@/lib/supabase.browser";
import { sanitizeServerError } from "@/lib/error-sanitize";

// Sends the signed-in user's token with every server-function call.
const attachAuth = createMiddleware({ type: "function" }).client(async ({ next }) => {
  const token = await currentAccessToken();
  return next({ headers: token ? { Authorization: `Bearer ${token}` } : {} });
});

// In production, database and stack text never reaches the browser.
const sanitizeErrors = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    throw sanitizeServerError(error, import.meta.env.PROD);
  }
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachAuth, sanitizeErrors],
}));
