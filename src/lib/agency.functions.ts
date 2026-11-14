// Platform-admin screens: every client workspace at a glance, creating one, suspending
// it, and setting its limits. Each handler checks is_platform_admin first because it then
// uses the service role, which bypasses RLS.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./auth-middleware";
import { requirePlatformAdmin } from "./tenant-access.server";
import { serviceClient } from "./supabase.server";
import { QuotaInput, WorkspaceInput } from "./agency/rules";
import { createWorkspace, overview, setQuotas, setStatus, type CreateResult, type WorkspaceHealth } from "./pipeline/agency.server";

const svc = (env: { GIE_DB_SCHEMA: string } & Record<string, any>) => serviceClient(env as any, env.GIE_DB_SCHEMA);

export const getWorkspaces = createServerFn({ method: "GET" })
  .middleware([requireUser])
  .handler(async ({ context }): Promise<WorkspaceHealth[]> => {
    await requirePlatformAdmin(context.supabase);
    return overview(svc(context.env), context.env.GIE_DAILY_SEND_CAP);
  });

export const createClientWorkspace = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => WorkspaceInput.parse(d))
  .handler(async ({ data, context }): Promise<CreateResult> => {
    await requirePlatformAdmin(context.supabase);
    const db = svc(context.env);
    const lookup = async (email: string) => {
      for (let page = 1; page <= 20; page++) {
        const { data: res, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(error.message);
        const hit = res.users.find((u) => u.email?.toLowerCase() === email);
        if (hit) return hit.id;
        if (res.users.length < 1000) break;
      }
      return null;
    };
    return createWorkspace(db, data, context.userId, lookup);
  });

export const setWorkspaceStatus = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ tenantId: z.string().uuid(), status: z.enum(["active", "suspended"]) }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await requirePlatformAdmin(context.supabase);
    await setStatus(svc(context.env), data.tenantId, data.status, context.userId);
    return { ok: true };
  });

export const setWorkspaceQuotas = createServerFn({ method: "POST" })
  .middleware([requireUser])
  .validator((d: unknown) => z.object({ tenantId: z.string().uuid(), quotas: QuotaInput }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await requirePlatformAdmin(context.supabase);
    await setQuotas(svc(context.env), data.tenantId, data.quotas, context.userId);
    return { ok: true };
  });
