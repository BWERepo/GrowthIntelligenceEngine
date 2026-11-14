// 30-Day Growth Performance for the screens. Built from the recorded outcome events
// (readable by members under RLS), plus the BWE workspace's site visit counts.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./auth-middleware";
import { requireTenantRole, SlugInput } from "./tenant-access.server";
import { bweReader } from "./bwe-source.server";
import { localMoment } from "./schedule";
import { loadReport, visitCounts } from "./pipeline/growth.server";
import type { GrowthReport } from "./growth/metrics";

export type GrowthView = { report: GrowthReport; connected: boolean; snapshots: Array<{ asOfDate: string }> };

export const getGrowth = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: SlugInput }).parse(d))
  .handler(async ({ data, context }): Promise<GrowthView> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "viewer");
    const row = { id: tenant.tenantId, slug: tenant.slug, timezone: tenant.timezone };
    const connected = tenant.slug === context.env.BWE_TENANT_SLUG;
    // Visit counts come from BWE's own table, which is only ever read for the BWE workspace.
    const visits = connected ? await visitCounts(bweReader(context.env), row, localMoment(new Date(), tenant.timezone).date) : null;
    const report = await loadReport(context.supabase, row, new Date(), { bweConnected: connected, visits });
    const snaps = await context.supabase.from("gie_growth_period_snapshots").select("as_of_date").eq("tenant_id", tenant.tenantId).order("as_of_date", { ascending: false }).limit(30);
    if (snaps.error) throw new Error(snaps.error.message);
    return { report, connected, snapshots: ((snaps.data ?? []) as Array<{ as_of_date: string }>).map((s) => ({ asOfDate: s.as_of_date })) };
  });
