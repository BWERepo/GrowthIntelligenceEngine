import { describe, expect, it } from "vitest";
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
