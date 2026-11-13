import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { browserSupabase } from "@/lib/supabase.browser";
import { Notice } from "@/components/ui";

export const Route = createFileRoute("/sign-in")({ component: SignInPage });

// Sign in with an existing Business Web Express back-office account. Accounts
// with an authenticator app get a second step for the 6-digit code, exactly as
// in the BWE admin.
function SignInPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const sb = browserSupabase();
      const { error: signInError } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) throw new Error("That email and password did not match.");
      const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
        const { data: factors } = await sb.auth.mfa.listFactors();
        const totp = factors?.totp.find((f) => f.status === "verified");
        if (totp) {
          setFactorId(totp.id);
          setStep("code");
          return;
        }
      }
      await navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    try {
      const { error: verifyError } = await browserSupabase().auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      if (verifyError) throw new Error("That code did not work. Check your authenticator app and try again.");
      await navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  }

  const input = "mt-1 w-full rounded-lg border border-line bg-card px-3 py-2.5 text-base outline-none focus:border-terracotta";
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <p className="font-mono text-[0.68rem] uppercase tracking-[0.22em] text-terracotta">Business Web Express</p>
      <h1 className="mt-1 font-display text-3xl tracking-tight">Growth Intelligence</h1>
      <p className="mt-2 text-espresso-soft">Sign in with your Business Web Express back-office account.</p>
      {error ? <div className="mt-4"><Notice tone="error">{error}</Notice></div> : null}
      {step === "password" ? (
        <form onSubmit={submitPassword} className="mt-6 space-y-4">
          <label className="block">Email
            <input className={input} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block">Password
            <input className={input} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button disabled={busy} className="w-full rounded-full bg-espresso px-5 py-3 font-medium text-parchment hover:bg-terracotta-deep disabled:opacity-60">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : (
        <form onSubmit={submitCode} className="mt-6 space-y-4">
          <label className="block">6-digit code from your authenticator app
            <input className={input} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <button disabled={busy} className="w-full rounded-full bg-espresso px-5 py-3 font-medium text-parchment hover:bg-terracotta-deep disabled:opacity-60">
            {busy ? "Checking…" : "Verify"}
          </button>
        </form>
      )}
    </main>
  );
}
