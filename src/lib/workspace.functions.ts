import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { FOCUSES, type Focus } from "./actions/ranking";
import { requireTenantRole } from "./tenant-access.server";
import { checkMailSettings, DEFAULT_MAIL_SETTINGS, effectiveFrom, type MailSettings } from "./mail/settings";
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
  schedule: { workingDays: number[]; morningTime: string; eveningTime: string; dailyFocus: Focus } | null;
  budgets: Array<{ category: string; period: string; limitUsd: number; alertAt: number[] }>;
  members: Array<{ userId: string; email: string | null; role: string; isYou: boolean }>;
  bwe: BweConnection | null;
  /** BWE workspace only: who outreach comes from, and what the Worker's mailbox secrets provide. */
  mail: {
    settings: MailSettings;
    shownFrom: string | null;
    loginUser: string | null;
    passwordSet: boolean;
    unsubscribeSecretSet: boolean;
    repliesMailbox: string | null;
  } | null;
};

function mailView(env: { LEAD_EMAIL_SMTP_USER?: string; LEAD_EMAIL_SMTP_PASSWORD?: string; UNSUBSCRIBE_SECRET?: string; EMAIL_LOG_IMAP_USER?: string }, row: { from_name: string; from_email: string | null; reply_to_email: string | null } | null): NonNullable<TenantSettings["mail"]> {
  const settings: MailSettings = row ? { fromName: row.from_name, fromEmail: row.from_email, replyTo: row.reply_to_email } : DEFAULT_MAIL_SETTINGS;
  return {
    settings,
    shownFrom: effectiveFrom(env.LEAD_EMAIL_SMTP_USER, settings),
    loginUser: env.LEAD_EMAIL_SMTP_USER ?? null,
    passwordSet: !!env.LEAD_EMAIL_SMTP_PASSWORD,
    unsubscribeSecretSet: !!env.UNSUBSCRIBE_SECRET,
    repliesMailbox: env.EMAIL_LOG_IMAP_USER || env.LEAD_EMAIL_SMTP_USER || null,
  };
}

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

    const isBweTenant = tenant.slug === context.env.BWE_TENANT_SLUG;
    const [schedule, budgets, members, mailRow] = await Promise.all([
      db.from("gie_tenant_work_schedules").select("working_days, morning_time, evening_time, daily_focus").eq("tenant_id", tenant.tenantId).maybeSingle(),
      db.from("gie_budgets").select("category, period, limit_usd, alert_at").eq("tenant_id", tenant.tenantId).order("category"),
      db.from("gie_tenant_memberships").select("user_id, role").eq("tenant_id", tenant.tenantId).order("role"),
      isBweTenant ? db.from("gie_tenant_mail_settings").select("from_name, from_email, reply_to_email").eq("tenant_id", tenant.tenantId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    for (const r of [schedule, budgets, members, mailRow]) if (r.error) throw new Error(r.error.message);

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
        ? { workingDays: schedule.data.working_days, morningTime: schedule.data.morning_time, eveningTime: schedule.data.evening_time, dailyFocus: schedule.data.daily_focus }
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
      mail: isBweTenant ? mailView(context.env, (mailRow.data as { from_name: string; from_email: string | null; reply_to_email: string | null } | null)) : null,
    };
  });

/** The owner picks what the day's plan leans towards; takes effect from the next package. */
export const saveDailyFocus = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/), focus: z.enum(FOCUSES) }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "owner");
    const db = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    const upd = await db.from("gie_tenant_work_schedules").update({ daily_focus: data.focus, updated_at: new Date().toISOString() }).eq("tenant_id", tenant.tenantId).select("tenant_id");
    if (upd.error) throw new Error(upd.error.message);
    if (!upd.data?.length) throw new Error("Not found: this workspace has no work schedule yet.");
    await db.from("gie_audit_events").insert({ tenant_id: tenant.tenantId, actor_user_id: context.userId, action: "schedule.focus", entity_type: "work_schedule", entity_id: tenant.tenantId, after: { focus: data.focus } });
    return { ok: true };
  });

/** The owner chooses the visible sender. The mailbox login and password are Worker secrets and cannot be set here. */
export const saveMailSettings = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/), fromName: z.string().max(200), fromEmail: z.string().max(300), replyTo: z.string().max(300) }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const tenant = await requireTenantRole(context.supabase, context.userId, data.slug, "owner");
    if (tenant.slug !== context.env.BWE_TENANT_SLUG) throw new Error("Forbidden: only the Business Web Express workspace sends email from this app.");
    const checked = checkMailSettings({ fromName: data.fromName, fromEmail: data.fromEmail, replyTo: data.replyTo });
    if (!checked.ok) throw new Error(`Invalid: ${checked.error}`);
    const db = serviceClient(context.env, context.env.GIE_DB_SCHEMA);
    const up = await db.from("gie_tenant_mail_settings").upsert({ tenant_id: tenant.tenantId, from_name: checked.value.fromName, from_email: checked.value.fromEmail, reply_to_email: checked.value.replyTo, updated_by: context.userId, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
    if (up.error) throw new Error(up.error.message);
    await db.from("gie_audit_events").insert({ tenant_id: tenant.tenantId, actor_user_id: context.userId, action: "mail.settings", entity_type: "mail_settings", entity_id: tenant.tenantId, after: { from_email: checked.value.fromEmail, reply_to: checked.value.replyTo } });
    return { ok: true };
  });
