import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./auth-middleware";
import { hasRole, resolveTenant, TENANT_ROLES, type Membership } from "./roles";
import { serviceClient } from "./supabase.server";
import { checkBweConnection, type BweConnection } from "./bwe-source.server";

const MembershipRow = z.object({
  role: z.enum(TENANT_ROLES),
  tenant: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string(), timezone: z.string(), status: z.string() }),
});

/** The signed-in user's tenants (read through RLS) and whether they are a BWE platform admin. */
export const getWorkspace = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }) => {
    const [members, admin] = await Promise.all([
      context.supabase
        .from("gie_tenant_memberships")
        .select("role, tenant:gie_tenants!inner(id, slug, name, timezone, status)")
        .eq("user_id", context.userId),
      context.supabase.rpc("is_platform_admin"),
    ]);
    if (members.error) throw new Error(members.error.message);
    const memberships: Membership[] = z
      .array(MembershipRow)
      .parse(members.data ?? [])
      .filter((r) => r.tenant.status === "active")
      .map((r) => ({ tenantId: r.tenant.id, slug: r.tenant.slug, name: r.tenant.name, timezone: r.tenant.timezone, role: r.role }));
    return { email: context.email, memberships, isPlatformAdmin: admin.data === true };
  });

const SettingsInput = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/) });

export type TenantSettings = {
  tenant: Membership;
  schedule: { workingDays: number[]; morningTime: string; eveningTime: string } | null;
  budgets: Array<{ category: string; period: string; limitUsd: number; alertAt: number[] }>;
  members: Array<{ userId: string; email: string | null; role: string; isYou: boolean }>;
  bwe: BweConnection | null;
};

/** Settings page: everything is read as the user (RLS), except member emails and the BWE check. */
export const getTenantSettings = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .validator((d: unknown) => SettingsInput.parse(d))
  .handler(async ({ data, context }): Promise<TenantSettings> => {
    const db = context.supabase;
    const { data: rows, error } = await db
      .from("gie_tenant_memberships")
      .select("role, tenant:gie_tenants!inner(id, slug, name, timezone, status)")
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    const mine = z.array(MembershipRow).parse(rows ?? []).map((r) => ({
      tenantId: r.tenant.id, slug: r.tenant.slug, name: r.tenant.name, timezone: r.tenant.timezone, role: r.role,
    }));
    const tenant = resolveTenant(mine, data.slug);
    if (!tenant) throw new Error("Forbidden: you do not have access to this workspace.");

    const [schedule, budgets, members] = await Promise.all([
      db.from("gie_tenant_work_schedules").select("working_days, morning_time, evening_time").eq("tenant_id", tenant.tenantId).maybeSingle(),
      db.from("gie_budgets").select("category, period, limit_usd, alert_at").eq("tenant_id", tenant.tenantId).order("category"),
      db.from("gie_tenant_memberships").select("user_id, role").eq("tenant_id", tenant.tenantId).order("role"),
    ]);
    for (const r of [schedule, budgets, members]) if (r.error) throw new Error(r.error.message);

    // Member emails live in auth.users, which only the service role can read; owners only.
    const emails = new Map<string, string | null>();
    if (hasRole(tenant.role, "owner")) {
      const admin = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
      await Promise.all(
        (members.data ?? []).map(async (m: { user_id: string }) => {
          const { data: u } = await admin.auth.admin.getUserById(m.user_id);
          emails.set(m.user_id, u.user?.email ?? null);
        }),
      );
    }

    const isBwe = tenant.slug === context.env.BWE_TENANT_SLUG;
    return {
      tenant,
      schedule: schedule.data
        ? { workingDays: schedule.data.working_days, morningTime: schedule.data.morning_time, eveningTime: schedule.data.evening_time }
        : null,
      budgets: (budgets.data ?? []).map((b: any) => ({
        category: b.category, period: b.period, limitUsd: Number(b.limit_usd), alertAt: (b.alert_at ?? []).map(Number),
      })),
      members: (members.data ?? []).map((m: { user_id: string; role: string }) => ({
        userId: m.user_id,
        email: m.user_id === context.userId ? context.email : (emails.get(m.user_id) ?? null),
        role: m.role,
        isYou: m.user_id === context.userId,
      })),
      bwe: isBwe ? await checkBweConnection(context.env) : null,
    };
  });
