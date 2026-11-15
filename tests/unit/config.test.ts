import { describe, expect, it, vi } from "vitest";
import { readServerEnv } from "@/lib/env.server";
import { sanitizeServerError } from "@/lib/error-sanitize";
// @ts-expect-error plain .mjs script without types
import { renderMigration } from "../../scripts/migration-render.mjs";

const base = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_xxxxxxxxxxxxxxxx", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_xxxxxxxxxxxxxxxxxxxx" };

describe("server configuration", () => {
  it("accepts matching staging schemas", () => {
    expect(readServerEnv({ ...base, GIE_DB_SCHEMA: "gie_staging", BWE_DB_SCHEMA: "bwe_staging" }).GIE_DB_SCHEMA).toBe("gie_staging");
  });
  it("refuses staging GIE reading production BWE, and the reverse", () => {
    expect(() => readServerEnv({ ...base, GIE_DB_SCHEMA: "gie_staging", BWE_DB_SCHEMA: "public" })).toThrow(/both be staging/);
    expect(() => readServerEnv({ ...base, GIE_DB_SCHEMA: "gie_prod", BWE_DB_SCHEMA: "bwe_staging" })).toThrow(/both be staging/);
  });
  it("names missing settings without printing values", () => {
    expect(() => readServerEnv({ GIE_DB_SCHEMA: "gie_prod", BWE_DB_SCHEMA: "public" })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("migration rendering", () => {
  const sql = "CREATE TABLE __SCHEMA__.t (); SELECT __BWE_SCHEMA__.has_role();";
  it("pairs gie_staging with bwe_staging and gie_prod with public", () => {
    expect(renderMigration(sql, "staging")).toBe("CREATE TABLE gie_staging.t (); SELECT bwe_staging.has_role();");
    expect(renderMigration(sql, "production")).toBe("CREATE TABLE gie_prod.t (); SELECT public.has_role();");
  });
  it("rejects unknown environments", () => {
    expect(() => renderMigration(sql, "prod")).toThrow();
  });
});

describe("error sanitizing", () => {
  it("hides database text in production", () => {
    expect(sanitizeServerError(new Error('relation "gie_prod.x" does not exist'), true).message).toMatch(/Something went wrong/);
  });
  it("keeps intentional messages", () => {
    expect(sanitizeServerError(new Error("Forbidden: you do not have access to this workspace."), true).message).toMatch(/^Forbidden/);
  });
  it("shows everything outside production", () => {
    expect(sanitizeServerError(new Error('relation "x"'), false).message).toBe('relation "x"');
  });
});

describe("pasted mail settings", () => {
  const ok = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "k".repeat(30), SUPABASE_SERVICE_ROLE_KEY: "s".repeat(30), GIE_DB_SCHEMA: "gie_staging", BWE_DB_SCHEMA: "bwe_staging" };
  it("trims spaces, quotes and a display name around the mailbox address", () => {
    expect(readServerEnv({ ...ok, LEAD_EMAIL_SMTP_USER: ' "Leads <leads@example.com>"\n' }).LEAD_EMAIL_SMTP_USER).toBe("leads@example.com");
    expect(readServerEnv({ ...ok, LEAD_EMAIL_SMTP_USER: "  leads@example.com \n" }).LEAD_EMAIL_SMTP_USER).toBe("leads@example.com");
  });
  it("ignores an unusable mail value instead of taking the app down, without leaking it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = readServerEnv({ ...ok, LEAD_EMAIL_SMTP_USER: "not an address", UNSUBSCRIBE_SECRET: "short" });
    expect(env.LEAD_EMAIL_SMTP_USER).toBeUndefined();
    expect(env.UNSUBSCRIBE_SECRET).toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/not an address|short/);
    warn.mockRestore();
  });
  it("says whether a required setting is missing or invalid", () => {
    expect(() => readServerEnv({ ...ok, SUPABASE_SERVICE_ROLE_KEY: undefined })).toThrow(/SUPABASE_SERVICE_ROLE_KEY \(missing\)/);
    expect(() => readServerEnv({ ...ok, SUPABASE_SERVICE_ROLE_KEY: "short" })).toThrow(/SUPABASE_SERVICE_ROLE_KEY \(set but not valid\)/);
  });
});
