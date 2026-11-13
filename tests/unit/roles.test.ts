import { describe, expect, it } from "vitest";
import { hasRole, resolveTenant, roleRank, type Membership } from "@/lib/roles";

const bwe: Membership = { tenantId: "a", slug: "bwe", name: "BWE", timezone: "America/New_York", role: "owner" };
const client: Membership = { tenantId: "b", slug: "client-b", name: "B", timezone: "America/Chicago", role: "viewer" };

describe("roles", () => {
  it("ranks owner > operator > viewer, unknown lowest", () => {
    expect(roleRank("owner")).toBeGreaterThan(roleRank("operator"));
    expect(roleRank("operator")).toBeGreaterThan(roleRank("viewer"));
    expect(roleRank("admin")).toBe(0);
  });
  it("checks minimum roles", () => {
    expect(hasRole("owner", "viewer")).toBe(true);
    expect(hasRole("viewer", "operator")).toBe(false);
    expect(hasRole(null, "viewer")).toBe(false);
    expect(hasRole("superuser", "viewer")).toBe(false);
  });
});

describe("resolveTenant", () => {
  it("uses the only membership when no tenant is requested", () => {
    expect(resolveTenant([bwe])).toBe(bwe);
  });
  it("never guesses when the user has several tenants", () => {
    expect(resolveTenant([bwe, client])).toBeNull();
  });
  it("returns the requested tenant only if the user belongs to it", () => {
    expect(resolveTenant([bwe, client], "client-b")).toBe(client);
    expect(resolveTenant([bwe], "client-b")).toBeNull();
  });
  it("returns null with no memberships", () => {
    expect(resolveTenant([])).toBeNull();
  });
});
