import { describe, expect, it } from "vitest";
import { mutableDb } from "./mutable-db";
import { afterFailure, claimFromJwt, hashPin, isLocked, isWellFormedPin, normalizePin, PIN_LOCK_MINUTES, PIN_MAX_FAILURES, sameHash } from "@/lib/pin";
import { sessionHasPin, verifyPinFor } from "@/lib/pipeline/pin.server";

const KEY = "test-message-key-0123456789";
const USER = "11111111-2222-3333-4444-555555555555";
const SESSION = "99999999-8888-7777-6666-555555555555";
const now = new Date("2026-11-16T15:00:00Z");

describe("PIN hash", () => {
  it("matches the keyed hash BWE stores (value computed independently with Python HMAC-SHA256)", async () => {
    expect(await hashPin("482913", USER, KEY)).toBe("4f8e8b05d7380c8b73315a063afc9eded0607fa789a098a8c24def157946a8b9");
  });
  it("is bound to the user and to the key", async () => {
    const a = await hashPin("482913", USER, KEY);
    expect(await hashPin("482913", "other-user", KEY)).not.toBe(a);
    expect(await hashPin("482913", USER, KEY + "x")).not.toBe(a);
  });
  it("normalizes and checks the shape", () => {
    expect(normalizePin(" 48-29 13 99")).toBe("482913");
    expect(isWellFormedPin("482913")).toBe(true);
    expect(isWellFormedPin("48291")).toBe(false);
    expect(sameHash("abc", "abc")).toBe(true);
    expect(sameHash("abc", "abd")).toBe(false);
    expect(sameHash("abc", "abcd")).toBe(false);
  });
  it("reads a claim from a token", () => {
    const t = `h.${Buffer.from(JSON.stringify({ session_id: SESSION })).toString("base64url")}.s`;
    expect(claimFromJwt(t, "session_id")).toBe(SESSION);
    expect(claimFromJwt(t, "nope")).toBeNull();
    expect(claimFromJwt("garbage", "session_id")).toBeNull();
  });
});

describe("lockout counter", () => {
  it("counts wrong PINs and locks at the limit", () => {
    expect(afterFailure(0, now)).toEqual({ failed_attempts: 1, locked_until: null });
    const locked = afterFailure(PIN_MAX_FAILURES - 1, now);
    expect(locked.failed_attempts).toBe(0);
    expect(new Date(locked.locked_until!).getTime() - now.getTime()).toBe(PIN_LOCK_MINUTES * 60_000);
    expect(isLocked(locked.locked_until, now)).toBe(true);
    expect(isLocked(locked.locked_until, new Date(now.getTime() + 16 * 60_000))).toBe(false);
    expect(isLocked(null, now)).toBe(false);
  });
});

describe("verifying a PIN", () => {
  const world = () => mutableDb({ gie_pin_attempts: [], gie_pin_sessions: [] });
  const deps = (db: any, hash: string | null) => ({ db, readHash: async () => hash, key: KEY, now });

  it("accepts the right PIN, resets the counter and marks the session", async () => {
    const db = world();
    db.tables.gie_pin_attempts.push({ user_id: USER, failed_attempts: 3, locked_until: null });
    const stored = await hashPin("482913", USER, KEY);
    expect(await verifyPinFor(deps(db, stored), USER, SESSION, "482-913")).toEqual({ ok: true });
    expect(db.tables.gie_pin_attempts[0]).toMatchObject({ failed_attempts: 0, locked_until: null });
    expect(await sessionHasPin(db as any, USER, SESSION)).toBe(true);
    expect(await sessionHasPin(db as any, "someone-else", SESSION)).toBe(false);
    expect(await sessionHasPin(db as any, USER, null)).toBe(false);
  });
  it("rejects a wrong PIN without marking the session, and locks after five", async () => {
    const db = world();
    const stored = await hashPin("482913", USER, KEY);
    for (let i = 1; i < PIN_MAX_FAILURES; i++) {
      expect(await verifyPinFor(deps(db, stored), USER, SESSION, "000111")).toEqual({ ok: false, reason: "That PIN did not work." });
      expect(db.tables.gie_pin_attempts[0].failed_attempts).toBe(i);
    }
    await verifyPinFor(deps(db, stored), USER, SESSION, "000111");
    expect(db.tables.gie_pin_attempts[0].locked_until).not.toBeNull();
    expect(await sessionHasPin(db as any, USER, SESSION)).toBe(false);
    // While locked even the right PIN is refused.
    const r = await verifyPinFor(deps(db, stored), USER, SESSION, "482913");
    expect(r).toMatchObject({ ok: false });
    expect((r as any).reason).toMatch(/Too many/);
    expect(await sessionHasPin(db as any, USER, SESSION)).toBe(false);
  });
  it("says so when the account has no PIN set, and treats a malformed PIN as wrong", async () => {
    const db = world();
    expect(await verifyPinFor(deps(db, null), USER, SESSION, "482913")).toMatchObject({ ok: false, reason: expect.stringMatching(/No PIN is set/) });
    const stored = await hashPin("482913", USER, KEY);
    expect(await verifyPinFor(deps(db, stored), USER, SESSION, "12")).toEqual({ ok: false, reason: "That PIN did not work." });
  });
});
