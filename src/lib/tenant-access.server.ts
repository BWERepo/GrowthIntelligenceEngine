// Resolves the caller's membership in the requested workspace, read through
// RLS with the caller's own token. Every server function that later uses the
// service role (which bypasses RLS) calls this first and checks the role.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { hasRole, resolveTenant, TENANT_ROLES, type Membership, type TenantRole } from "./roles";

const MembershipRow = z.object({
  role: z.enum(TENANT_ROLES),
  tenant: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string(), timezone: z.string(), status: z.string() }),
});

export const SlugInput = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/);

export async function requireTenantRole(
  db: SupabaseClient<any, any, any>,
  userId: string,
  slug: string,
  minimum: TenantRole,
): Promise<Membership> {
  const { data, error } = await db
    .from("gie_tenant_memberships")
    .select("role, tenant:gie_tenants!inner(id, slug, name, timezone, status)")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const mine = z
    .array(MembershipRow)
    .parse(data ?? [])
    .filter((r) => r.tenant.status === "active")
    .map((r) => ({ tenantId: r.tenant.id, slug: r.tenant.slug, name: r.tenant.name, timezone: r.tenant.timezone, role: r.role }));
  const tenant = resolveTenant(mine, slug);
  if (!tenant) throw new Error("Forbidden: you do not have access to this workspace.");
  if (!hasRole(tenant.role, minimum)) throw new Error(`Forbidden: this needs the ${minimum} role or higher.`);
  return tenant;
}

/** Platform-admin check (BWE back-office admins, 2FA enforced by BWE's own has_role). Read through the caller's token. */
export async function requirePlatformAdmin(db: SupabaseClient<any, any, any>): Promise<void> {
  const { data, error } = await db.rpc("is_platform_admin");
  if (error) throw new Error(error.message);
  if (data !== true) throw new Error("Forbidden: this needs a platform administrator.");
}
