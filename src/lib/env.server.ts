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
    // Phase 2 providers. Optional: without a key that step is skipped and the
    // run says which key is missing; nothing is faked.
    ANTHROPIC_API_KEY: z.string().min(20).optional(),
    BRAVE_SEARCH_API_KEY: z.string().min(10).optional(),
    PAGESPEED_API_KEY: z.string().min(10).optional(),
    // Phase 3 mail. Same names and values as BWE's lead mailbox; without them nothing is sent
    // and replies are not read, and the screens say which setting is missing.
    LEAD_EMAIL_SMTP_HOST: z.string().optional(),
    LEAD_EMAIL_SMTP_PORT: z.string().optional(),
    LEAD_EMAIL_SMTP_USER: z.string().email().optional(),
    LEAD_EMAIL_SMTP_PASSWORD: z.string().min(8).optional(),
    LEAD_EMAIL_IMAP_HOST: z.string().optional(),
    EMAIL_LOG_IMAP_USER: z.string().email().optional(),
    EMAIL_LOG_IMAP_PASSWORD: z.string().min(8).optional(),
    UNSUBSCRIBE_SECRET: z.string().min(16).optional(),
    UNSUBSCRIBE_BASE_URL: z.string().url().default("https://businesswebexpress.com"),
    GIE_DAILY_SEND_CAP: z.coerce.number().int().min(1).max(200).default(20),
    GIE_CLASSIFY_MODEL: z.enum(["claude-opus-5-5", "claude-haiku-5-5"]).default("claude-opus-5-5"),
  })
  .refine((e) => (e.GIE_DB_SCHEMA === "gie_prod") === (e.BWE_DB_SCHEMA === "public"), {
    message: "GIE_DB_SCHEMA and BWE_DB_SCHEMA must both be staging or both be production",
  });

export type ServerEnv = z.infer<typeof EnvSchema>;

/** Secrets pasted into a dashboard often carry spaces, a line break, quotes or a "Name <address>" wrapper. */
export function cleanValue(v: string | undefined, kind: "text" | "email" = "text"): string | undefined {
  if (v === undefined) return undefined;
  let t = v.trim().replace(/^(["'])(.*)\1$/s, "$2").trim();
  if (kind === "email") {
    const m = t.match(/<([^<>\s]+)>/);
    if (m) t = m[1]!;
  }
  return t === "" ? undefined : t;
}

// Mail settings are optional: a value that is present but not usable is treated as not set (and logged by
// name, never by value), so a bad mail secret switches sending off instead of taking the whole app down.
const MAIL_CHECKS: Record<string, { kind: "text" | "email"; ok: (v: string) => boolean }> = {
  LEAD_EMAIL_SMTP_USER: { kind: "email", ok: (v) => z.string().email().safeParse(v).success },
  LEAD_EMAIL_SMTP_PASSWORD: { kind: "text", ok: (v) => v.length >= 8 },
  EMAIL_LOG_IMAP_USER: { kind: "email", ok: (v) => z.string().email().safeParse(v).success },
  EMAIL_LOG_IMAP_PASSWORD: { kind: "text", ok: (v) => v.length >= 8 },
  UNSUBSCRIBE_SECRET: { kind: "text", ok: (v) => v.length >= 16 },
};

export function readServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const cleaned: Record<string, string | undefined> = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, typeof v === "string" ? cleanValue(v, MAIL_CHECKS[k]?.kind) : undefined]));
  for (const [name, check] of Object.entries(MAIL_CHECKS)) {
    const v = cleaned[name];
    if (v !== undefined && !check.ok(v)) {
      console.warn(`[config] ${name} is set but not valid, so it is ignored (the value is not shown).`);
      cleaned[name] = undefined;
    }
  }
  const parsed = EnvSchema.safeParse({
    ...cleaned,
    // The browser build reads the same URL and key as VITE_ vars; accept either name.
    SUPABASE_URL: cleaned.SUPABASE_URL ?? cleaned.VITE_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: cleaned.SUPABASE_PUBLISHABLE_KEY ?? cleaned.VITE_SUPABASE_PUBLISHABLE_KEY,
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".") || i.message} (${source[i.path[0] as string] === undefined || cleaned[i.path[0] as string] === undefined ? "missing" : "set but not valid"})`).join(", ");
    throw new Error(`Server configuration is incomplete: ${fields}`);
  }
  return parsed.data;
}
