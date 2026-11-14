-- Growth Intelligence Engine: Phase 8, agency readiness. Needs the Phase 7 migration.
--
-- 1. A suspended or archived workspace stops working for its members at the database
--    level, not just in the app (platform admins keep access so they can look after it).
-- 2. Per-workspace limits (active campaigns, team size, daily emails) enforced by the
--    database, so no code path can skip them.

-- 1. Membership only counts while the workspace is active.
CREATE OR REPLACE FUNCTION __SCHEMA__.has_tenant_role(_tenant_id uuid, _min_role text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (
      SELECT 1
      FROM __SCHEMA__.gie_tenant_memberships m
      JOIN __SCHEMA__.gie_tenants t ON t.id = m.tenant_id
      WHERE m.tenant_id = _tenant_id
        AND t.status = 'active'
        AND m.user_id = auth.uid()
        AND __SCHEMA__.role_rank(m.role) >= __SCHEMA__.role_rank(_min_role)
    )
    OR __SCHEMA__.is_platform_admin()
  )
$$;

-- 2. Limits. A workspace without a row gets the defaults below.
CREATE TABLE __SCHEMA__.gie_tenant_quotas (
  tenant_id uuid PRIMARY KEY REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  max_active_campaigns smallint NOT NULL DEFAULT 3 CHECK (max_active_campaigns BETWEEN 0 AND 100),
  max_members smallint NOT NULL DEFAULT 5 CHECK (max_members BETWEEN 1 AND 200),
  -- Emails per rolling 24 hours; never above the app-wide cap, which stays in force.
  daily_send_cap smallint CHECK (daily_send_cap BETWEEN 0 AND 200),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE __SCHEMA__.gie_tenant_quotas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read quotas" ON __SCHEMA__.gie_tenant_quotas
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
GRANT SELECT ON __SCHEMA__.gie_tenant_quotas TO authenticated;
GRANT ALL ON __SCHEMA__.gie_tenant_quotas TO service_role;

-- BWE's own workspace is not held to client limits.
INSERT INTO __SCHEMA__.gie_tenant_quotas (tenant_id, max_active_campaigns, max_members)
SELECT id, 50, 50 FROM __SCHEMA__.gie_tenants WHERE slug = 'bwe';
INSERT INTO __SCHEMA__.gie_tenant_quotas (tenant_id)
SELECT id FROM __SCHEMA__.gie_tenants WHERE slug <> 'bwe';

CREATE FUNCTION __SCHEMA__.enforce_campaign_quota()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  cap smallint;
  active_count integer;
BEGIN
  IF NEW.status <> 'active' OR (TG_OP = 'UPDATE' AND OLD.status = 'active') THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(q.max_active_campaigns, 3) INTO cap
  FROM (SELECT 1) x LEFT JOIN __SCHEMA__.gie_tenant_quotas q ON q.tenant_id = NEW.tenant_id;
  SELECT count(*) INTO active_count FROM __SCHEMA__.gie_campaigns WHERE tenant_id = NEW.tenant_id AND status = 'active' AND id <> NEW.id;
  IF active_count >= cap THEN
    RAISE EXCEPTION 'This workspace is limited to % active campaigns', cap USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gie_campaigns_quota BEFORE INSERT OR UPDATE ON __SCHEMA__.gie_campaigns
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.enforce_campaign_quota();

CREATE FUNCTION __SCHEMA__.enforce_member_quota()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  cap smallint;
  member_count integer;
BEGIN
  SELECT coalesce(q.max_members, 5) INTO cap
  FROM (SELECT 1) x LEFT JOIN __SCHEMA__.gie_tenant_quotas q ON q.tenant_id = NEW.tenant_id;
  SELECT count(*) INTO member_count FROM __SCHEMA__.gie_tenant_memberships WHERE tenant_id = NEW.tenant_id;
  IF member_count >= cap THEN
    RAISE EXCEPTION 'This workspace is limited to % team members', cap USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gie_memberships_quota BEFORE INSERT ON __SCHEMA__.gie_tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.enforce_member_quota();

NOTIFY pgrst, 'reload schema';
