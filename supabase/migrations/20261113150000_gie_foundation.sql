-- Growth Intelligence Engine: Phase 1 foundation.
--
-- Template, not runnable as-is. scripts/migration-render.mjs replaces
--   __SCHEMA__      with gie_staging or gie_prod   (where GIE's own tables live)
--   __BWE_SCHEMA__  with bwe_staging or public     (BWE's schema in the same
--                   environment; read here only for has_role / user_roles)
-- so staging GIE only ever looks at staging BWE.
--
-- Isolation model: every row carries tenant_id. Access is granted only by a
-- row in gie_tenant_memberships (or by being a BWE platform admin), never by
-- "authenticated" alone: HDBS users and BWE customers share auth.users.
-- Rows written only by the server (audit, usage, job runs) have no INSERT
-- grant for authenticated at all.

CREATE SCHEMA IF NOT EXISTS __SCHEMA__;
GRANT USAGE ON SCHEMA __SCHEMA__ TO authenticated, service_role;

-- ---------------------------------------------------------------- tenants
CREATE TABLE __SCHEMA__.gie_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- IANA zone name; validated against pg_timezone_names by the trigger below.
  timezone text NOT NULL DEFAULT 'America/New_York',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE __SCHEMA__.gie_tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX gie_tenant_memberships_user_idx ON __SCHEMA__.gie_tenant_memberships (user_id);

-- ---------------------------------------------------------------- access helpers
-- BWE back-office admins (BWE's own has_role, which already requires a 2FA
-- session for admins who enrolled an authenticator).
CREATE FUNCTION __SCHEMA__.is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(__BWE_SCHEMA__.has_role(auth.uid(), 'admin'), false)
$$;

CREATE FUNCTION __SCHEMA__.role_rank(_role text)
RETURNS int
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE _role WHEN 'owner' THEN 3 WHEN 'operator' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END
$$;

-- True when the caller is a member of _tenant_id with at least _min_role, or a
-- platform admin. SECURITY DEFINER so policies can call it without granting
-- callers direct read access to every membership row.
CREATE FUNCTION __SCHEMA__.has_tenant_role(_tenant_id uuid, _min_role text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM __SCHEMA__.gie_tenant_memberships m
      WHERE m.tenant_id = _tenant_id
        AND m.user_id = auth.uid()
        AND __SCHEMA__.role_rank(m.role) >= __SCHEMA__.role_rank(_min_role)
    )
    OR __SCHEMA__.is_platform_admin()
  )
$$;

REVOKE ALL ON FUNCTION __SCHEMA__.is_platform_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION __SCHEMA__.has_tenant_role(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SCHEMA__.is_platform_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION __SCHEMA__.has_tenant_role(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION __SCHEMA__.role_rank(text) TO authenticated, service_role;

CREATE FUNCTION __SCHEMA__.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION __SCHEMA__.check_timezone()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown time zone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- schedules and calendar
CREATE TABLE __SCHEMA__.gie_tenant_work_schedules (
  tenant_id uuid PRIMARY KEY REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  -- ISO weekdays, 1 = Monday ... 7 = Sunday.
  working_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}'
    CHECK (working_days <@ '{1,2,3,4,5,6,7}'::smallint[] AND cardinality(working_days) BETWEEN 1 AND 7),
  morning_time time NOT NULL DEFAULT '08:00',
  evening_time time NOT NULL DEFAULT '17:00',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (morning_time < evening_time)
);

CREATE TABLE __SCHEMA__.gie_business_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  closed_on date NOT NULL,
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, closed_on)
);

CREATE TABLE __SCHEMA__.gie_notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  morning_email boolean NOT NULL DEFAULT false,
  evening_email boolean NOT NULL DEFAULT false,
  budget_alerts boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

-- ---------------------------------------------------------------- audit, usage, budgets, job runs
CREATE TABLE __SCHEMA__.gie_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_kind text NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'system')),
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
  entity_type text NOT NULL CHECK (char_length(entity_type) BETWEEN 1 AND 60),
  entity_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gie_audit_events_tenant_time_idx ON __SCHEMA__.gie_audit_events (tenant_id, created_at DESC);

CREATE TABLE __SCHEMA__.gie_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL CHECK (category IN ('ai', 'search', 'other')),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 60),
  operation text NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 60),
  model text,
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  units integer NOT NULL DEFAULT 1 CHECK (units >= 0),
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  is_estimate boolean NOT NULL DEFAULT true,
  request_id text,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX gie_usage_events_tenant_time_idx ON __SCHEMA__.gie_usage_events (tenant_id, occurred_at DESC);

CREATE TABLE __SCHEMA__.gie_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('total', 'ai', 'search')),
  period text NOT NULL CHECK (period IN ('day', 'month')),
  limit_usd numeric(10, 2) NOT NULL CHECK (limit_usd >= 0),
  -- Fractions of the limit at which an alert is raised, ascending, each in (0, 1).
  alert_at numeric[] NOT NULL DEFAULT '{0.5,0.8}'
    CHECK (0 < ALL (alert_at) AND 1 > ALL (alert_at)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, category, period)
);

CREATE TABLE __SCHEMA__.gie_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  job_kind text NOT NULL CHECK (job_kind IN
    ('morning_package', 'end_of_day_review', 'discovery', 'weekly_review', 'monthly_review')),
  -- The tenant-local date the run is for: the idempotency key with job_kind.
  local_date date NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  attempt smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  late boolean NOT NULL DEFAULT false,
  error text CHECK (char_length(error) <= 2000),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, job_kind, local_date)
);

-- ---------------------------------------------------------------- triggers
CREATE TRIGGER gie_tenants_touch BEFORE UPDATE ON __SCHEMA__.gie_tenants
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();
CREATE TRIGGER gie_tenants_timezone BEFORE INSERT OR UPDATE OF timezone ON __SCHEMA__.gie_tenants
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.check_timezone();
CREATE TRIGGER gie_tenant_memberships_touch BEFORE UPDATE ON __SCHEMA__.gie_tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();
CREATE TRIGGER gie_tenant_work_schedules_touch BEFORE UPDATE ON __SCHEMA__.gie_tenant_work_schedules
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();
CREATE TRIGGER gie_notification_preferences_touch BEFORE UPDATE ON __SCHEMA__.gie_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();
CREATE TRIGGER gie_budgets_touch BEFORE UPDATE ON __SCHEMA__.gie_budgets
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();

-- ---------------------------------------------------------------- row level security
ALTER TABLE __SCHEMA__.gie_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_tenant_work_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_business_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_job_runs ENABLE ROW LEVEL SECURITY;

-- Tenants: members read; owners rename / change time zone. Creating, suspending
-- and deleting tenants is a platform-admin job done by the server.
CREATE POLICY "Members read their tenant" ON __SCHEMA__.gie_tenants
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(id, 'viewer'));
CREATE POLICY "Owners update their tenant" ON __SCHEMA__.gie_tenants
  FOR UPDATE TO authenticated
  USING (__SCHEMA__.has_tenant_role(id, 'owner'))
  WITH CHECK (__SCHEMA__.has_tenant_role(id, 'owner'));

-- Memberships: members see their team; owners manage it.
CREATE POLICY "Members read memberships" ON __SCHEMA__.gie_tenant_memberships
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Owners manage memberships" ON __SCHEMA__.gie_tenant_memberships
  FOR ALL TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'owner'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'owner'));

CREATE POLICY "Members read schedule" ON __SCHEMA__.gie_tenant_work_schedules
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Owners manage schedule" ON __SCHEMA__.gie_tenant_work_schedules
  FOR ALL TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'owner'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'owner'));

CREATE POLICY "Members read calendar" ON __SCHEMA__.gie_business_calendar
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Owners manage calendar" ON __SCHEMA__.gie_business_calendar
  FOR ALL TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'owner'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'owner'));

-- Notification preferences: each member manages only their own row.
CREATE POLICY "Members manage own notification preferences" ON __SCHEMA__.gie_notification_preferences
  FOR ALL TO authenticated
  USING (user_id = auth.uid() AND __SCHEMA__.has_tenant_role(tenant_id, 'viewer'))
  WITH CHECK (user_id = auth.uid() AND __SCHEMA__.has_tenant_role(tenant_id, 'viewer'));

CREATE POLICY "Owners read audit events" ON __SCHEMA__.gie_audit_events
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'owner'));

CREATE POLICY "Operators read usage" ON __SCHEMA__.gie_usage_events
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));

CREATE POLICY "Members read budgets" ON __SCHEMA__.gie_budgets
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Owners manage budgets" ON __SCHEMA__.gie_budgets
  FOR ALL TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'owner'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'owner'));

CREATE POLICY "Members read job runs" ON __SCHEMA__.gie_job_runs
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));

-- ---------------------------------------------------------------- grants
GRANT SELECT, UPDATE ON __SCHEMA__.gie_tenants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  __SCHEMA__.gie_tenant_memberships,
  __SCHEMA__.gie_tenant_work_schedules,
  __SCHEMA__.gie_business_calendar,
  __SCHEMA__.gie_notification_preferences,
  __SCHEMA__.gie_budgets
  TO authenticated;
-- Server-written only: no INSERT/UPDATE/DELETE for signed-in users, and the
-- audit trail is append-only even for the server.
GRANT SELECT ON __SCHEMA__.gie_audit_events, __SCHEMA__.gie_usage_events, __SCHEMA__.gie_job_runs TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA __SCHEMA__ TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON __SCHEMA__.gie_audit_events FROM service_role;

-- ---------------------------------------------------------------- seed: BWE as tenant 1
INSERT INTO __SCHEMA__.gie_tenants (slug, name, timezone)
VALUES ('bwe', 'Business Web Express', 'America/New_York');

INSERT INTO __SCHEMA__.gie_tenant_work_schedules (tenant_id)
SELECT id FROM __SCHEMA__.gie_tenants WHERE slug = 'bwe';

-- $50/month hard cap on AI + search (owner decision, 2026-11-13).
INSERT INTO __SCHEMA__.gie_budgets (tenant_id, category, period, limit_usd, alert_at)
SELECT id, 'total', 'month', 50, '{0.5,0.8}' FROM __SCHEMA__.gie_tenants WHERE slug = 'bwe';

-- Every BWE back-office admin in this environment becomes an owner of the BWE tenant.
INSERT INTO __SCHEMA__.gie_tenant_memberships (tenant_id, user_id, role)
SELECT t.id, r.user_id, 'owner'
FROM __SCHEMA__.gie_tenants t
CROSS JOIN (SELECT DISTINCT user_id FROM __BWE_SCHEMA__.user_roles WHERE role::text = 'admin') r
WHERE t.slug = 'bwe';

NOTIFY pgrst, 'reload schema';
