import { describe, expect, it } from "vitest";
import { aalFromJwt, hasVerifiedAuthenticator, needsSecondFactor } from "@/lib/mfa";

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

describe("second factor rules", () => {
  it("reads the assurance level from a token", () => {
    expect(aalFromJwt(jwt({ aal: "aal2" }))).toBe("aal2");
    expect(aalFromJwt(jwt({ aal: "aal1" }))).toBe("aal1");
    expect(aalFromJwt(jwt({}))).toBeNull();
    expect(aalFromJwt("garbage")).toBeNull();
  });
  it("counts only a verified authenticator", () => {
    expect(hasVerifiedAuthenticator([{ factor_type: "totp", status: "verified" }])).toBe(true);
    expect(hasVerifiedAuthenticator([{ factor_type: "totp", status: "unverified" }])).toBe(false);
    expect(hasVerifiedAuthenticator([{ factor_type: "phone", status: "verified" }])).toBe(false);
    expect(hasVerifiedAuthenticator(undefined)).toBe(false);
  });
  it("refuses a password-only session only when the account has an authenticator", () => {
    const factors = [{ factor_type: "totp", status: "verified" }];
    expect(needsSecondFactor("aal1", factors)).toBe(true);
    expect(needsSecondFactor(null, factors)).toBe(true);
    expect(needsSecondFactor("aal2", factors)).toBe(false);
    expect(needsSecondFactor("aal1", [])).toBe(false);
  });
});
