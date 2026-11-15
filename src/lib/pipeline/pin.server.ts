// Checks the BWE back-office PIN at sign-in and records that this session passed it. The attempt counter
// and the session marker live in GIE's own tables; BWE's table is only read.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterFailure, hashPin, isLocked, isWellFormedPin, normalizePin, PIN_LOCK_MINUTES, sameHash } from "@/lib/pin";

type Db = SupabaseClient<any, any, any>;
export type PinResult = { ok: true } | { ok: false; reason: string };

const BAD = "That PIN did not work.";

export async function verifyPinFor(
  deps: { db: Db; readHash: (userId: string) => Promise<string | null>; key: string; now?: Date },
  userId: string,
  sessionId: string,
  rawPin: string,
): Promise<PinResult> {
  const now = deps.now ?? new Date();
  const pin = normalizePin(rawPin);

  const row = await deps.db.from("gie_pin_attempts").select("failed_attempts, locked_until").eq("user_id", userId).maybeSingle();
  if (row.error) throw new Error(row.error.message);
  if (isLocked(row.data?.locked_until, now)) return { ok: false, reason: `Too many wrong PINs. Try again in ${PIN_LOCK_MINUTES} minutes.` };

  const stored = await deps.readHash(userId);
  if (!stored) return { ok: false, reason: "No PIN is set for this account. Set your 6-digit code in the BWE back-office first, then sign in again." };

  const matches = isWellFormedPin(pin) && sameHash(stored, await hashPin(pin, userId, deps.key));
  if (!matches) {
    const next = afterFailure(row.data?.failed_attempts ?? 0, now);
    const up = await deps.db.from("gie_pin_attempts").upsert({ user_id: userId, ...next, updated_at: now.toISOString() }, { onConflict: "user_id" });
    if (up.error) throw new Error(up.error.message);
    return { ok: false, reason: BAD };
  }

  const reset = await deps.db.from("gie_pin_attempts").upsert({ user_id: userId, failed_attempts: 0, locked_until: null, updated_at: now.toISOString() }, { onConflict: "user_id" });
  if (reset.error) throw new Error(reset.error.message);
  const mark = await deps.db.from("gie_pin_sessions").upsert({ session_id: sessionId, user_id: userId, verified_at: now.toISOString() }, { onConflict: "session_id" });
  if (mark.error) throw new Error(mark.error.message);
  // Old markers are not needed: a session that old has expired anyway.
  await deps.db.from("gie_pin_sessions").delete().eq("user_id", userId).lt("verified_at", new Date(now.getTime() - 60 * 86_400_000).toISOString());
  return { ok: true };
}

/** True when this session passed the PIN check. */
export async function sessionHasPin(db: Db, userId: string, sessionId: string | null): Promise<boolean> {
  if (!sessionId) return false;
  const r = await db.from("gie_pin_sessions").select("session_id").eq("session_id", sessionId).eq("user_id", userId).maybeSingle();
  if (r.error) throw new Error(r.error.message);
  return !!r.data;
}
