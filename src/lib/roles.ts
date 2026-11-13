// Tenant roles, mirrored from role_rank() in the foundation migration. The
// database enforces these through RLS; the server checks them again because
// service-role queries bypass RLS.
export const TENANT_ROLES = ["viewer", "operator", "owner"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export function roleRank(role: string): number {
  const i = TENANT_ROLES.indexOf(role as TenantRole);
  return i + 1; // unknown roles rank 0
}

export function hasRole(actual: string | null | undefined, minimum: TenantRole): boolean {
  return !!actual && roleRank(actual) >= roleRank(minimum);
}

export type Membership = { tenantId: string; slug: string; name: string; timezone: string; role: TenantRole };

// Picks the tenant a request works on: the requested slug if the user belongs
// to it, otherwise their only tenant. Platform admins may open any tenant they
// can read, but a missing or unknown slug never silently falls back to another
// tenant when the user has more than one.
export function resolveTenant(memberships: Membership[], requestedSlug?: string | null): Membership | null {
  if (requestedSlug) return memberships.find((m) => m.slug === requestedSlug) ?? null;
  return memberships.length === 1 ? memberships[0]! : null;
}
