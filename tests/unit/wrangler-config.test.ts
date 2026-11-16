import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// wrangler.jsonc with // comments removed (no "//" appears inside its strings except URLs, which this pattern skips).
function readWrangler(): any {
  const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(text);
}

describe("wrangler configuration", () => {
  it("keeps the production address on the production Worker only", () => {
    const w = readWrangler();
    expect(w.routes).toEqual([{ pattern: "growthintelligence.businesswebexpress.com", custom_domain: true }]);
    // Wrangler inherits top-level routes into an environment that does not set its own:
    // staging must say "no routes" or each staging deploy takes over the production address.
    expect(w.env.staging.routes).toEqual([]);
    expect(w.env.staging.vars.GIE_DB_SCHEMA).toBe("gie_staging");
    expect(w.vars.GIE_DB_SCHEMA).toBe("gie_prod");
  });
});
