import { useEffect, useState } from "react";
import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { browserSupabase } from "@/lib/supabase.browser";
import { getWorkspace } from "@/lib/workspace.functions";
import { resolveTenant } from "@/lib/roles";
import { WorkspaceContext } from "@/lib/use-workspace";
import { Notice } from "@/components/ui";

export const NAV = [
  { to: "/", label: "Daily Action Center" },
  { to: "/opportunities", label: "Opportunities" },
  { to: "/prospects", label: "Prospects" },
  { to: "/follow-ups", label: "Follow-Ups" },
  { to: "/review", label: "End-of-Day Review" },
  { to: "/performance", label: "Growth Performance" },
  { to: "/campaigns", label: "Campaigns" },
  { to: "/reports", label: "Reports" },
  { to: "/settings", label: "Settings" },
] as const;

export const Route = createFileRoute("/_app")({
  validateSearch: z.object({ t: z.string().optional() }),
  component: AppLayout,
});

function AppLayout() {
  const navigate = useNavigate();
  const { t } = Route.useSearch();
  const [session, setSession] = useState<"checking" | "in" | "out">("checking");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const sb = browserSupabase();
    sb.auth.getSession().then(({ data }) => setSession(data.session ? "in" : "out"));
    const { data: sub } = sb.auth.onAuthStateChange((_event, s) => setSession(s ? "in" : "out"));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (session === "out") void navigate({ to: "/sign-in" });
  }, [session, navigate]);

  const fetchWorkspace = useServerFn(getWorkspace);
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: () => fetchWorkspace(), enabled: session === "in" });

  if (session !== "in" || workspace.isLoading) {
    return <p className="p-8 text-espresso-soft" role="status">Loading…</p>;
  }
  if (workspace.error) {
    return <div className="mx-auto max-w-lg p-8"><Notice tone="error">{workspace.error.message}</Notice></div>;
  }
  const ws = workspace.data!;
  const tenant = resolveTenant(ws.memberships, t);
  if (!tenant) {
    return (
      <main className="mx-auto max-w-lg space-y-4 p-8">
        <h1 className="font-display text-2xl">{ws.memberships.length ? "Choose a workspace" : "No access yet"}</h1>
        {ws.memberships.length ? (
          <ul className="space-y-2">
            {ws.memberships.map((m) => (
              <li key={m.slug}><Link to="/" search={{ t: m.slug }} className="text-terracotta underline">{m.name}</Link></li>
            ))}
          </ul>
        ) : (
          <p className="text-espresso-soft">Your account ({ws.email}) is signed in but is not a member of any Growth Intelligence workspace. Ask the workspace owner to add you.</p>
        )}
        <button className="text-sm underline" onClick={() => browserSupabase().auth.signOut()}>Sign out</button>
      </main>
    );
  }

  return (
    <WorkspaceContext.Provider value={{ tenant, email: ws.email, isPlatformAdmin: ws.isPlatformAdmin }}>
      <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
        <aside className="border-b border-line bg-card lg:min-h-screen lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between px-4 py-4 lg:block lg:px-5 lg:py-6">
            <div>
              <p className="font-mono text-[0.65rem] uppercase tracking-[0.22em] text-terracotta">Growth Intelligence</p>
              <p className="font-display text-lg font-semibold tracking-tight">{tenant.name}</p>
            </div>
            <button className="rounded-lg border border-line px-3 py-2 lg:hidden" aria-expanded={menuOpen} aria-controls="app-nav" onClick={() => setMenuOpen((o) => !o)}>
              Menu
            </button>
          </div>
          <nav id="app-nav" aria-label="Growth Intelligence" className={`${menuOpen ? "block" : "hidden"} px-2 pb-4 lg:block`}>
            <ul className="space-y-0.5">
              {NAV.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    search={t ? { t } : {}}
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2.5 text-espresso-soft hover:bg-parchment-deep hover:text-espresso"
                    activeProps={{ className: "bg-parchment-deep font-medium text-espresso" }}
                    activeOptions={{ exact: item.to === "/", includeSearch: false }}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-6 border-t border-line px-3 pt-4 text-xs text-espresso-soft">
              <p className="truncate">{ws.email}</p>
              <button className="mt-1 underline" onClick={() => browserSupabase().auth.signOut()}>Sign out</button>
            </div>
          </nav>
        </aside>
        <main className="mx-auto w-full max-w-[72rem] px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
    </WorkspaceContext.Provider>
  );
}
