// Renders a templated migration for one environment, the same way BWE's
// scripts/apply-migration.mjs does for its own schemas.
//
//   node scripts/migration-render.mjs <file> staging      -> gie_staging (reads bwe_staging)
//   node scripts/migration-render.mjs <file> production   -> gie_prod    (reads public)
//   node scripts/migration-render.mjs <file> --split      -> writes <file>.staging.sql and <file>.production.sql
//
// Output is pasted into the Supabase SQL editor: run staging first, check it,
// then production. Nothing here connects to a database.
import { readFileSync, writeFileSync } from "node:fs";

export const ENVIRONMENTS = {
  staging: { schema: "gie_staging", bweSchema: "bwe_staging" },
  production: { schema: "gie_prod", bweSchema: "public" },
};

export function renderMigration(sql, env) {
  const target = ENVIRONMENTS[env];
  if (!target) throw new Error(`Unknown environment "${env}" (use staging or production)`);
  const out = sql.replaceAll("__BWE_SCHEMA__", target.bweSchema).replaceAll("__SCHEMA__", target.schema);
  if (/__[A-Z_]+__/.test(out.replace(/--.*$/gm, ""))) {
    throw new Error("Unrendered placeholder left in migration");
  }
  return out;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [file, mode] = process.argv.slice(2);
  if (!file || !mode) {
    console.error("usage: node scripts/migration-render.mjs <file> <staging|production|--split>");
    process.exit(1);
  }
  const sql = readFileSync(file, "utf8");
  if (mode === "--split") {
    for (const env of Object.keys(ENVIRONMENTS)) {
      const outFile = file.replace(/\.sql$/, `.${env}.sql`);
      writeFileSync(outFile, `-- Rendered for ${env}. Do not edit; edit ${file} and re-render.\n` + renderMigration(sql, env));
      console.log(`wrote ${outFile}`);
    }
  } else {
    process.stdout.write(renderMigration(sql, mode));
  }
}
