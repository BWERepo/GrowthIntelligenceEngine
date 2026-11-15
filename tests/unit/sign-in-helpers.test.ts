import { describe, expect, it } from "vitest";
import { readRememberedEmail, signInMessage, writeRememberedEmail } from "@/lib/sign-in-helpers";

const fakeStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), _m: m };
};

describe("remember my email", () => {
  it("stores only the email when ticked, and forgets it when not", () => {
    const s = fakeStorage();
    writeRememberedEmail(s, " me@biz.net ", true);
    expect(readRememberedEmail(s)).toBe("me@biz.net");
    expect([...s._m.values()]).toEqual(["me@biz.net"]);
    writeRememberedEmail(s, "me@biz.net", false);
    expect(readRememberedEmail(s)).toBe("");
  });
  it("copes with blocked storage", () => {
    const blocked: any = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(readRememberedEmail(blocked)).toBe("");
    expect(() => writeRememberedEmail(blocked, "a@b.co", true)).not.toThrow();
    expect(readRememberedEmail(undefined)).toBe("");
  });
});

describe("sign-in messages", () => {
  it("says 'did not match' only for a credentials failure", () => {
    expect(signInMessage({ code: "invalid_credentials", status: 400, message: "Invalid login credentials" })).toMatch(/did not match/);
    expect(signInMessage({ status: 400, message: "Invalid login credentials" })).toMatch(/did not match/);
  });
  it("names other causes instead of blaming the password", () => {
    expect(signInMessage({ status: 429, message: "x" })).toMatch(/Too many/);
    expect(signInMessage({ message: "Invalid API key" })).toMatch(/Supabase key/);
    expect(signInMessage({ message: "Failed to fetch" })).toMatch(/Could not reach/);
    expect(signInMessage({ code: "email_not_confirmed" })).toMatch(/confirmed/);
    expect(signInMessage({ message: "weird" })).toMatch(/did not work/);
  });
});
