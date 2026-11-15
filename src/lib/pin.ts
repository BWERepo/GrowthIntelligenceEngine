// The BWE back-office PIN: a fixed 6-digit code the admin set in the BWE back-office. BWE stores only a
// keyed hash of it; this file checks a typed PIN against that hash the same way BWE does (HMAC-SHA256
// keyed by BWE's MESSAGE_ENCRYPTION_KEY and bound to the user). Pure, so it can be tested.
export const PIN_LENGTH = 6;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MINUTES = 15;

export const normalizePin = (input: string) => input.replace(/\D/g, "").slice(0, PIN_LENGTH);
export const isWellFormedPin = (pin: string) => /^\d{6}$/.test(pin);

/** Must produce exactly what BWE's hashLoginCode produces. */
export async function hashPin(pin: string, userId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`bwe-admin-quick-code:${userId}:${pin}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares without stopping at the first different character. */
export function sameHash(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function isLocked(lockedUntil: string | null | undefined, now: Date): boolean {
  return !!lockedUntil && new Date(lockedUntil).getTime() > now.getTime();
}

/** The counter after one more wrong PIN: it locks at the limit, then starts again. */
export function afterFailure(failed: number, now: Date): { failed_attempts: number; locked_until: string | null } {
  const next = failed + 1;
  return next >= PIN_MAX_FAILURES
    ? { failed_attempts: 0, locked_until: new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000).toISOString() }
    : { failed_attempts: next, locked_until: null };
}

/** A claim of a JWT. Only call this on a token Supabase has already verified. */
export function claimFromJwt(token: string, name: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")) as Record<string, unknown>;
    return typeof json[name] === "string" ? (json[name] as string) : null;
  } catch {
    return null;
  }
}
