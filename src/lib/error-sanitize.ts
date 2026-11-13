// Adapted from BWE src/lib/error-sanitize.ts: intentional messages
// ("Unauthorized: ...", "Forbidden: ...", validation text) pass through; anything
// that looks like database, file-path or stack text is replaced in production.
const SAFE_PREFIXES = ["Unauthorized:", "Forbidden:", "Not found:", "Invalid:", "Server configuration is incomplete"];
const LEAKY = [/relation "|column "|violates|duplicate key|syntax error|PGRST|postgres/i, /\bat .+\(.+:\d+:\d+\)/, /\/[\w.-]+\/[\w.-]+\.(ts|js|mjs)\b/];

export function sanitizeServerError(error: unknown, isProduction: boolean): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!isProduction || SAFE_PREFIXES.some((p) => message.startsWith(p))) {
    return error instanceof Error ? error : new Error(message);
  }
  if (LEAKY.some((r) => r.test(message))) {
    console.error("[server error]", message);
    return new Error("Something went wrong on our side. Please try again.");
  }
  return error instanceof Error ? error : new Error(message);
}
