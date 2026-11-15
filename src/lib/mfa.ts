// Second-factor rules. A password alone gives a session at assurance level "aal1"; the
// authenticator code lifts it to "aal2". An account that has a verified authenticator
// must not use the app at aal1, or the code step could be skipped by going straight to a page.

/** The assurance level claim of a JWT. Only call this on a token Supabase has already verified. */
export function aalFromJwt(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")) as { aal?: unknown };
    return typeof json.aal === "string" ? json.aal : null;
  } catch {
    return null;
  }
}

export type FactorLike = { factor_type?: string; status?: string };

export function hasVerifiedAuthenticator(factors: FactorLike[] | null | undefined): boolean {
  return (factors ?? []).some((f) => f.factor_type === "totp" && f.status === "verified");
}

/** True when this session still owes the authenticator code. */
export function needsSecondFactor(aal: string | null, factors: FactorLike[] | null | undefined): boolean {
  return aal !== "aal2" && hasVerifiedAuthenticator(factors);
}
