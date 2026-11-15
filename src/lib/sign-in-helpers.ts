// Small pieces of the sign-in page that are worth testing on their own.
const KEY = "gie.rememberedEmail";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Only the email is ever remembered, never the password. Storage can be blocked, so every call is guarded. */
export function readRememberedEmail(storage: StorageLike | undefined): string {
  try {
    return storage?.getItem(KEY)?.slice(0, 254) ?? "";
  } catch {
    return "";
  }
}

export function writeRememberedEmail(storage: StorageLike | undefined, email: string, remember: boolean): void {
  try {
    if (remember && email.trim()) storage?.setItem(KEY, email.trim());
    else storage?.removeItem(KEY);
  } catch {
    /* blocked storage: nothing to remember */
  }
}

/** A plain sentence for a failed password sign-in. Only a real credentials failure says "did not match". */
export function signInMessage(error: { status?: number; code?: string; message?: string }): string {
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code === "invalid_credentials" || /invalid login credentials/i.test(message)) return "That email and password did not match.";
  if (error.status === 429 || /rate limit|too many/i.test(code + message)) return "Too many attempts. Wait a few minutes and try again.";
  if (code === "email_not_confirmed") return "That email address has not been confirmed yet.";
  if (/invalid api key|apikey/i.test(message)) return "This app cannot reach its sign-in service (its Supabase key is not accepted). Tell the owner.";
  if (/failed to fetch|network|load failed/i.test(message)) return "Could not reach the sign-in service. Check your connection and try again.";
  return "Sign-in did not work. Try again, and tell the owner if it keeps happening.";
}
