-- Tenant-isolation tests for the GIE foundation migration (staging rendering).
-- Each block raises on failure; psql runs with ON_ERROR_STOP.
\set QUIET on
\set VERBOSITY terse

-- Fixture: a second tenant (an agency client) with its own owner, and a viewer on BWE.
INSERT INTO gie_staging.gie_tenants (slug, name, timezone) VALUES ('client-b', 'Client B', 'America/Chicago');
INSERT INTO gie_staging.gie_budgets (tenant_id, category, period, limit_usd)
  SELECT id, 'total', 'month', 20 FROM gie_staging.gie_tenants WHERE slug = 'client-b';
INSERT INTO gie_staging.gie_tenant_memberships (tenant_id, user_id, role)
  SELECT id, '00000000-0000-0000-0000-0000000000a1'::uuid, 'owner' FROM gie_staging.gie_tenants WHERE slug = 'bwe'
  UNION ALL
  SELECT id, '00000000-0000-0000-0000-0000000000a2'::uuid, 'viewer' FROM gie_staging.gie_tenants WHERE slug = 'bwe'
  UNION ALL
  SELECT id, '00000000-0000-0000-0000-0000000000b1'::uuid, 'owner' FROM gie_staging.gie_tenants WHERE slug = 'client-b';
INSERT INTO gie_staging.gie_audit_events (tenant_id, actor_kind, action, entity_type)
  SELECT id, 'system', 'test.seed', 'tenant' FROM gie_staging.gie_tenants;
INSERT INTO gie_staging.gie_usage_events (tenant_id, category, provider, operation, cost_usd, idempotency_key)
  SELECT id, 'ai', 'anthropic', 'classify', 0.01, 'k-' || slug FROM gie_staging.gie_tenants;

CREATE FUNCTION pg_temp.act_as(_user text, _aal text DEFAULT 'aal1') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', _user, false);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _user, 'aal', _aal)::text, false);
END $$;
CREATE FUNCTION pg_temp.expect(_ok boolean, _what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(_ok, false) THEN RAISE EXCEPTION 'FAILED: %', _what; END IF;
  RAISE NOTICE 'ok - %', _what;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated, service_role;
-- Tenant ids looked up up front, so cross-tenant writes target a real id
-- instead of an RLS-filtered (empty) lookup.
SELECT FROM (SELECT set_config('test.bwe_id', id::text, false) FROM gie_staging.gie_tenants WHERE slug = 'bwe') x;
SELECT FROM (SELECT set_config('test.b_id', id::text, false) FROM gie_staging.gie_tenants WHERE slug = 'client-b') x;

\set QUIET off
-- 1. Seed: BWE tenant, schedule, $50 budget, admin is owner.
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_tenant_memberships m JOIN gie_staging.gie_tenants t ON t.id = m.tenant_id
  WHERE t.slug = 'bwe' AND m.user_id = '00000000-0000-0000-0000-00000000000a' AND m.role = 'owner'), 'seed makes BWE admins owners of the BWE tenant');
SELECT pg_temp.expect((SELECT limit_usd = 50 FROM gie_staging.gie_budgets b JOIN gie_staging.gie_tenants t ON t.id = b.tenant_id
  WHERE t.slug = 'bwe' AND category = 'total' AND period = 'month'), 'seed sets the $50 monthly cap');
SELECT pg_temp.expect((SELECT morning_time = '08:00' AND evening_time = '17:00' FROM gie_staging.gie_tenant_work_schedules s
  JOIN gie_staging.gie_tenants t ON t.id = s.tenant_id WHERE t.slug = 'bwe'), 'seed schedule is 08:00 / 17:00');

SET ROLE authenticated;

-- 2. Client B's owner sees only Client B.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT array_agg(slug) = '{client-b}' FROM gie_staging.gie_tenants), 'tenant B owner sees only tenant B');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_tenant_memberships), 'tenant B owner sees only tenant B memberships');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_budgets), 'tenant B owner sees only tenant B budgets');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_audit_events), 'tenant B owner sees only tenant B audit events');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_usage_events), 'tenant B owner sees only tenant B usage');

-- 3. Client B's owner cannot add themselves to BWE, or change BWE's budget.
DO $$ BEGIN
  INSERT INTO gie_staging.gie_tenant_memberships (tenant_id, user_id, role)
  VALUES (current_setting('test.bwe_id')::uuid, '00000000-0000-0000-0000-0000000000b1', 'owner');
  RAISE EXCEPTION 'FAILED: tenant B owner joined tenant A';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - tenant B owner cannot join tenant A';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_budgets SET limit_usd = 9999
  WHERE tenant_id = current_setting('test.bwe_id')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: tenant B owner changed tenant A budget'; END IF;
  RAISE NOTICE 'ok - tenant B owner cannot change tenant A budget';
END $$;

-- 4. BWE viewer reads but cannot change.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect((SELECT array_agg(slug) = '{bwe}' FROM gie_staging.gie_tenants), 'viewer sees own tenant');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_audit_events), 'viewer cannot read audit events (owners only)');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_usage_events), 'viewer cannot read usage (operators and up)');
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_tenants SET name = 'Hacked';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: viewer renamed tenant'; END IF;
  RAISE NOTICE 'ok - viewer cannot rename tenant';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_tenant_memberships (tenant_id, user_id, role)
  VALUES (current_setting('test.b_id')::uuid, '00000000-0000-0000-0000-0000000000a2', 'owner');
  RAISE EXCEPTION 'FAILED: viewer joined another tenant';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - viewer cannot add themselves to another tenant';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_tenant_memberships SET role = 'owner' WHERE user_id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: viewer upgraded own role'; END IF;
  RAISE NOTICE 'ok - viewer cannot upgrade own role';
END $$;

-- 5. Users with no membership see nothing: another site's user, a BWE customer, and anonymous.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_tenants), 'user from another site sees no tenants');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_tenants), 'BWE customer sees no tenants');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_tenant_memberships), 'BWE customer sees no memberships');
SELECT pg_temp.act_as('');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_tenants), 'no signed-in user sees no tenants');

-- 6. Platform admin with an authenticator: not an admin until the 2FA code is entered.
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a', 'aal1');
SELECT pg_temp.expect((SELECT NOT gie_staging.is_platform_admin()), 'enrolled admin is not platform admin at aal1');
SELECT pg_temp.expect((SELECT array_agg(slug) = '{bwe}' FROM gie_staging.gie_tenants), 'admin at aal1 sees only tenants they belong to');
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a', 'aal2');
SELECT pg_temp.expect((SELECT gie_staging.is_platform_admin()), 'enrolled admin is platform admin at aal2');
SELECT pg_temp.expect((SELECT count(*) = 2 FROM gie_staging.gie_tenants), 'platform admin at aal2 sees all tenants');

-- 7. Server-written tables: signed-in users cannot write them at all.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
DO $$ BEGIN
  INSERT INTO gie_staging.gie_usage_events (tenant_id, category, provider, operation, idempotency_key)
  SELECT id, 'ai', 'x', 'y', 'forged' FROM gie_staging.gie_tenants WHERE slug = 'bwe';
  RAISE EXCEPTION 'FAILED: owner wrote usage';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - owner cannot write usage events';
END $$;
DO $$ BEGIN
  DELETE FROM gie_staging.gie_audit_events;
  RAISE EXCEPTION 'FAILED: owner deleted audit events';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - owner cannot delete audit events';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_job_runs (tenant_id, job_kind, local_date)
  SELECT id, 'morning_package', current_date FROM gie_staging.gie_tenants WHERE slug = 'bwe';
  RAISE EXCEPTION 'FAILED: owner wrote job run';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - owner cannot write job runs';
END $$;

-- 8. Owner can manage own team and budget.
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_budgets SET limit_usd = 60
  WHERE tenant_id = (SELECT id FROM gie_staging.gie_tenants WHERE slug = 'bwe');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAILED: owner could not change own budget'; END IF;
  RAISE NOTICE 'ok - owner can change own budget';
END $$;

-- 9. Notification preferences are per person.
INSERT INTO gie_staging.gie_notification_preferences (tenant_id, user_id, morning_email)
  SELECT id, auth.uid(), true FROM gie_staging.gie_tenants WHERE slug = 'bwe';
DO $$ BEGIN
  INSERT INTO gie_staging.gie_notification_preferences (tenant_id, user_id)
  SELECT id, '00000000-0000-0000-0000-0000000000a2' FROM gie_staging.gie_tenants WHERE slug = 'bwe';
  RAISE EXCEPTION 'FAILED: owner set someone else''s preferences';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - preferences can only be set for yourself';
END $$;

RESET ROLE;

-- 10. Server role: job runs are idempotent per tenant, kind and local date; audit is append-only.
SET ROLE service_role;
INSERT INTO gie_staging.gie_job_runs (tenant_id, job_kind, local_date)
  SELECT id, 'morning_package', '2026-11-16' FROM gie_staging.gie_tenants WHERE slug = 'bwe';
DO $$ DECLARE n int; BEGIN
  INSERT INTO gie_staging.gie_job_runs (tenant_id, job_kind, local_date)
  SELECT id, 'morning_package', '2026-11-16' FROM gie_staging.gie_tenants WHERE slug = 'bwe'
  ON CONFLICT (tenant_id, job_kind, local_date) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: second claim of the same job succeeded'; END IF;
  RAISE NOTICE 'ok - a job can be claimed only once per tenant and local date';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_audit_events SET action = 'rewritten';
  RAISE EXCEPTION 'FAILED: server rewrote audit';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - audit events cannot be rewritten, even by the server';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_usage_events (tenant_id, category, provider, operation, idempotency_key)
  SELECT id, 'ai', 'anthropic', 'classify', 'k-bwe' FROM gie_staging.gie_tenants WHERE slug = 'bwe';
  RAISE EXCEPTION 'FAILED: duplicate usage event recorded';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - a usage event is recorded once per idempotency key';
END $$;
RESET ROLE;

-- 11. Data checks.
DO $$ BEGIN
  UPDATE gie_staging.gie_tenants SET timezone = 'Mars/Olympus' WHERE slug = 'bwe';
  RAISE EXCEPTION 'FAILED: invalid time zone accepted';
EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'ok - invalid time zone rejected';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_tenant_work_schedules SET working_days = '{0,8}';
  RAISE EXCEPTION 'FAILED: invalid weekday accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - invalid working days rejected';
END $$;

SELECT 'ALL DATABASE TESTS PASSED' AS result;
