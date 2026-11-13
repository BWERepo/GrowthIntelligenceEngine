import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser client for sign-in only. Same Supabase project as BWE, so BWE admin
// accounts (and their authenticator codes) work here. Data is never read from
// the browser directly: every read goes through a server function.
let client: SupabaseClient | null = null;

export function browserSupabase(): SupabaseClient {
  if (!client) {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
    if (!url || !key) throw new Error("This build is missing its Supabase settings (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).");
    client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "gie-auth" } });
  }
  return client;
}

export async function currentAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const { data } = await browserSupabase().auth.getSession();
  return data.session?.access_token ?? null;
}
