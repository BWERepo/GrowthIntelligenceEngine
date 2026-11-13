import type { ReactNode } from "react";

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-6">
      <h1 className="font-display text-2xl tracking-tight text-espresso">{title}</h1>
      {description ? <p className="mt-1 max-w-2xl text-espresso-soft">{description}</p> : null}
    </header>
  );
}

export function Panel({ title, kicker, children, emphasis = "normal" }: { title: string; kicker?: string; children: ReactNode; emphasis?: "primary" | "normal" | "supporting" }) {
  const size = emphasis === "primary" ? "p-6 md:p-8" : emphasis === "supporting" ? "p-4 md:p-5" : "p-5 md:p-6";
  const heading = emphasis === "primary" ? "text-xl" : emphasis === "supporting" ? "text-base" : "text-lg";
  return (
    <section className={`rounded-2xl border border-line bg-card ${size}`} aria-label={title}>
      {kicker ? <p className="mb-1 font-mono text-[0.68rem] uppercase tracking-[0.22em] text-terracotta">{kicker}</p> : null}
      <h2 className={`font-display ${heading} font-semibold tracking-tight`}>{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Honest empty state: says what is missing and when it will appear. Never shows placeholder numbers. */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-parchment px-4 py-6 text-center">
      <p className="font-medium text-espresso">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-espresso-soft">{children}</p>
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  const cls = tone === "error" ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-line bg-parchment-deep text-espresso";
  return <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 ${cls}`}>{children}</div>;
}
