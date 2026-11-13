import { z } from "zod";

// Runtime configuration. Schema names are plain Worker vars (wrangler.jsonc);
// the service-role key is a Worker secret. Staging and production must never
// point at each other's schemas, so the pairing is checked here too.
const EnvSchema = z
  .object({
    SUPABASE_URL: z.string().url(),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    GIE_DB_SCHEMA: z.enum(["gie_staging", "gie_prod"]),
    BWE_DB_SCHEMA: z.enum(["bwe_staging", "public"]),
    BWE_TENANT_SLUG: z.string().default("bwe"),
  })
  .refine((e) => (e.GIE_DB_SCHEMA === "gie_prod") === (e.BWE_DB_SCHEMA === "public"), {
    message: "GIE_DB_SCHEMA and BWE_DB_SCHEMA must both be staging or both be production",
  });

export type ServerEnv = z.infer<typeof EnvSchema>;

export function readServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const parsed = EnvSchema.safeParse({
    ...source,
    // The browser build reads the same URL and key as VITE_ vars; accept either name.
    SUPABASE_URL: source.SUPABASE_URL ?? source.VITE_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: source.SUPABASE_PUBLISHABLE_KEY ?? source.VITE_SUPABASE_PUBLISHABLE_KEY,
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ");
    throw new Error(`Server configuration is incomplete: ${fields}`);
  }
  return parsed.data;
}
