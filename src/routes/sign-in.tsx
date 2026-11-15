import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { verifyPin } from "@/lib/pin.functions";
import { browserSupabase } from "@/lib/supabase.browser";
import { Notice } from "@/components/ui";
import { readRememberedEmail, signInMessage, writeRememberedEmail } from "@/lib/sign-in-helpers";

export const Route = createFileRoute("/sign-in")({ component: SignInPage });

// Sign in with an existing Business Web Express back-office account: email, password and the
// same 6-digit PIN the person set in the BWE back-office.
function SignInPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const checkPin = useServerFn(verifyPin);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);

  // Prefill the email saved on this device (never the password).
  useEffect(() => {
    const saved = readRememberedEmail(typeof window === "undefined" ? undefined : window.localStorage);
    if (saved) {
      setEmail(saved);
      setRemember(true);
    }
  }, []);

  // One form: email, password and PIN together. The password gives a session; the PIN step then marks
  // that session as finished. The app refuses a session that has not passed the PIN, so it cannot be skipped.
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const sb = browserSupabase();
    try {
      const { error: signInError } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) throw new Error(signInMessage(signInError));
      writeRememberedEmail(window.localStorage, email, remember);
      try {
        await checkPin({ data: { pin } });
      } catch (pinError) {
        await sb.auth.signOut();
        const text = pinError instanceof Error ? pinError.message.replace(/^(Invalid|Unauthorized|Forbidden):\s*/, "") : "";
        throw new Error(text || "That PIN did not work.");
      }
      await navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  const input = "mt-1 w-full rounded-lg border border-line bg-card px-3 py-2.5 text-base outline-none focus:border-terracotta";
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <img src="/bwe-logo.png" width={520} height={374} alt="Business Web Express" className="mb-6 h-36 w-auto self-start" />
      <h1 className="font-display text-3xl tracking-tight">Growth Intelligence</h1>
      <p className="mt-2 text-espresso-soft">Sign in with your Business Web Express back-office account.</p>
      {error ? <div className="mt-4"><Notice tone="error">{error}</Notice></div> : null}
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block">Email
          <input className={input} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block">Password
          <input className={input} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="block">PIN
          <input className={input} type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} required placeholder="6-digit PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
          <span className="mt-1 block text-sm text-espresso-soft">The same 6-digit PIN you use in the BWE back-office.</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember my email on this device
        </label>
        <button disabled={busy} className="w-full rounded-full bg-espresso px-5 py-3 font-medium text-parchment hover:bg-terracotta-deep disabled:opacity-60">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
