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


-- ================================================================ Phase 2: discovery and scoring
-- 12. Seed: BWE gets one draft campaign; nothing searches until someone activates it.
SELECT pg_temp.expect((SELECT count(*) = 1 AND bool_and(c.status = 'draft') FROM gie_staging.gie_campaigns c
  JOIN gie_staging.gie_tenants t ON t.id = c.tenant_id WHERE t.slug = 'bwe'), 'seed adds one draft campaign for BWE');

-- Fixture: one campaign, page, queued candidate, opportunity, classification and score per tenant.
INSERT INTO gie_staging.gie_campaigns (tenant_id, name, status)
  SELECT id, 'Client B campaign', 'active' FROM gie_staging.gie_tenants WHERE slug = 'client-b';
INSERT INTO gie_staging.gie_sources (tenant_id, source_type, normalized_url, host, robots_allowed, content_text)
  SELECT t.id, 'web_page', 'https://' || t.slug || '-biz.com', t.slug || '-biz.com', true, 'page text' FROM gie_staging.gie_tenants t;
INSERT INTO gie_staging.gie_discovery_candidates (tenant_id, campaign_id, signal_type, query, provider, url, normalized_url, local_date)
  SELECT c.tenant_id, c.id, 'prospecting', 'q', 'brave', 'https://' || t.slug || '-biz.com', 'https://' || t.slug || '-biz.com', '2026-11-16'
  FROM gie_staging.gie_campaigns c JOIN gie_staging.gie_tenants t ON t.id = c.tenant_id;
INSERT INTO gie_staging.gie_opportunities (tenant_id, campaign_id, source_id, signal_type, business_name, source_url, dedupe_key, latest_score, latest_band)
  SELECT c.tenant_id, c.id, s.id, 'prospecting', t.name || ' prospect', s.normalized_url, 'site:' || s.host, 61, 'review'
  FROM gie_staging.gie_campaigns c JOIN gie_staging.gie_tenants t ON t.id = c.tenant_id
  JOIN gie_staging.gie_sources s ON s.tenant_id = c.tenant_id;
INSERT INTO gie_staging.gie_opportunity_classifications (tenant_id, candidate_id, source_id, schema_version, prompt_version, model, outcome, output)
  SELECT d.tenant_id, d.id, s.id, 'opportunity-v1', 'classify-v1', 'claude-opus-5-5', 'accepted', '{"summary":"x"}'
  FROM gie_staging.gie_discovery_candidates d JOIN gie_staging.gie_sources s ON s.tenant_id = d.tenant_id;
INSERT INTO gie_staging.gie_opportunity_scores (tenant_id, opportunity_id, classification_id, rule_version, score, band, inputs)
  SELECT o.tenant_id, o.id, k.id, 'opportunity-score-v1', 61, 'review', '{}'
  FROM gie_staging.gie_opportunities o JOIN gie_staging.gie_opportunity_classifications k ON k.tenant_id = o.tenant_id;
INSERT INTO gie_staging.gie_opportunity_score_components (tenant_id, score_id, component, weight, value, points, explanation)
  SELECT tenant_id, id, 'fit', 30, 0.9, 27, 'test' FROM gie_staging.gie_opportunity_scores;
SELECT FROM (SELECT set_config('test.bwe_opp', o.id::text, false) FROM gie_staging.gie_opportunities o
  JOIN gie_staging.gie_tenants t ON t.id = o.tenant_id WHERE t.slug = 'bwe') x;
SELECT FROM (SELECT set_config('test.bwe_campaign', c.id::text, false) FROM gie_staging.gie_campaigns c
  JOIN gie_staging.gie_tenants t ON t.id = c.tenant_id WHERE t.slug = 'bwe') x;

SET ROLE authenticated;

-- 13. Client B's owner sees only Client B's discovery data, and cannot touch BWE's.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_campaigns), 'tenant B owner sees only tenant B campaigns');
SELECT pg_temp.expect((SELECT array_agg(business_name) = '{"Client B prospect"}' FROM gie_staging.gie_opportunities), 'tenant B owner sees only tenant B opportunities');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_sources), 'tenant B owner sees only tenant B sources');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_discovery_candidates), 'tenant B owner sees only tenant B queue');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_opportunity_classifications), 'tenant B owner sees only tenant B classifications');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_opportunity_scores), 'tenant B owner sees only tenant B scores');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_opportunity_score_components), 'tenant B owner sees only tenant B score components');
DO $$ BEGIN
  INSERT INTO gie_staging.gie_campaigns (tenant_id, name) VALUES (current_setting('test.bwe_id')::uuid, 'Planted');
  RAISE EXCEPTION 'FAILED: tenant B owner created a campaign in tenant A';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - tenant B owner cannot create a campaign in tenant A';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_opportunities SET status = 'archived' WHERE id = current_setting('test.bwe_opp')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: tenant B owner changed tenant A opportunity'; END IF;
  RAISE NOTICE 'ok - tenant B owner cannot change tenant A opportunities';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_campaigns SET status = 'active' WHERE id = current_setting('test.bwe_campaign')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: tenant B owner activated tenant A campaign'; END IF;
  RAISE NOTICE 'ok - tenant B owner cannot change tenant A campaigns';
END $$;

-- 14. BWE viewer: reads opportunities and scores, cannot change anything, cannot see the queue.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_opportunities), 'viewer reads own tenant opportunities');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_opportunity_score_components), 'viewer reads score breakdown');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_discovery_candidates), 'viewer cannot read the discovery queue (operators and up)');
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_opportunities SET status = 'saved';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: viewer changed an opportunity status'; END IF;
  RAISE NOTICE 'ok - viewer cannot change opportunity status';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_campaigns (tenant_id, name) VALUES (current_setting('test.bwe_id')::uuid, 'Viewer campaign');
  RAISE EXCEPTION 'FAILED: viewer created a campaign';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - viewer cannot create campaigns';
END $$;

-- 15. BWE owner: may change status (and only status), never the AI or score records.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_opportunities SET status = 'dismissed', dismiss_reason = 'not a fit' WHERE id = current_setting('test.bwe_opp')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAILED: owner could not dismiss'; END IF;
  RAISE NOTICE 'ok - owner can change opportunity status';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_opportunities SET latest_score = 100 WHERE id = current_setting('test.bwe_opp')::uuid;
  RAISE EXCEPTION 'FAILED: owner rewrote a score';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - owner cannot edit an opportunity''s score';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_opportunities SET status = 'dismissed', dismiss_reason = NULL WHERE id = current_setting('test.bwe_opp')::uuid;
  RAISE EXCEPTION 'FAILED: dismissed without a reason';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - dismissing needs a reason';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_opportunity_scores (tenant_id, opportunity_id, classification_id, rule_version, score, band, inputs)
  SELECT tenant_id, opportunity_id, id, 'forged', 100, 'very_high', '{}' FROM gie_staging.gie_opportunity_classifications LIMIT 1;
  RAISE EXCEPTION 'FAILED: owner wrote a score';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - owner cannot write scores';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_opportunities (tenant_id, campaign_id, source_id, signal_type, business_name, source_url, dedupe_key)
  SELECT tenant_id, campaign_id, source_id, signal_type, 'Forged', source_url, 'forged' FROM gie_staging.gie_opportunities LIMIT 1;
  RAISE EXCEPTION 'FAILED: owner created an opportunity by hand';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - opportunities are created by discovery only';
END $$;
DO $$ BEGIN
  PERFORM gie_staging.claim_discovery_candidates(current_setting('test.bwe_id')::uuid, 5);
  RAISE EXCEPTION 'FAILED: signed-in user claimed queue items';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - only the server can claim queue items';
END $$;

-- 16. A BWE customer and another site's user see no discovery data.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_opportunities) AND (SELECT count(*) = 0 FROM gie_staging.gie_campaigns), 'BWE customer sees no campaigns or opportunities');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_sources) AND (SELECT count(*) = 0 FROM gie_staging.gie_opportunity_scores), 'other site''s user sees no sources or scores');
RESET ROLE;

-- 17. Server role: tenant-safe references, permanent records, and a race-free queue.
SET ROLE service_role;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_opportunities (tenant_id, campaign_id, source_id, signal_type, business_name, source_url, dedupe_key)
  SELECT current_setting('test.b_id')::uuid, current_setting('test.bwe_campaign')::uuid, s.id, 'prospecting', 'Cross', 'https://x.com', 'cross'
  FROM gie_staging.gie_sources s WHERE s.tenant_id = current_setting('test.b_id')::uuid;
  RAISE EXCEPTION 'FAILED: tenant B row pointed at tenant A campaign';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ok - a row cannot point at another tenant''s campaign';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_opportunities (tenant_id, campaign_id, source_id, signal_type, business_name, source_url, dedupe_key)
  SELECT tenant_id, campaign_id, source_id, signal_type, 'Again', source_url, dedupe_key FROM gie_staging.gie_opportunities
  WHERE id = current_setting('test.bwe_opp')::uuid;
  RAISE EXCEPTION 'FAILED: duplicate business accepted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - one opportunity per business per tenant';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_opportunity_scores SET score = 100;
  RAISE EXCEPTION 'FAILED: score rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - scores cannot be rewritten, even by the server';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_opportunity_classifications SET output = '{"summary":"changed"}';
  RAISE EXCEPTION 'FAILED: classification rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - classifications cannot be rewritten';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_opportunity_classifications k SET opportunity_id = o.id
  FROM gie_staging.gie_opportunities o WHERE o.tenant_id = k.tenant_id AND k.opportunity_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN RAISE EXCEPTION 'FAILED: could not link classifications'; END IF;
  RAISE NOTICE 'ok - a classification can be linked to its opportunity once';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_opportunity_classifications SET opportunity_id = NULL;
  RAISE EXCEPTION 'FAILED: classification unlinked';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - the link cannot be changed afterwards';
END $$;
DO $$ BEGIN
  DELETE FROM gie_staging.gie_opportunity_classifications;
  RAISE EXCEPTION 'FAILED: classifications deleted';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - classifications cannot be deleted';
END $$;
INSERT INTO gie_staging.gie_discovery_candidates (tenant_id, campaign_id, signal_type, query, provider, url, normalized_url, local_date)
  SELECT current_setting('test.bwe_id')::uuid, current_setting('test.bwe_campaign')::uuid, 'buying_intent', 'q', 'brave',
         'https://p' || g || '.com', 'https://p' || g || '.com', '2026-11-16'
  FROM generate_series(1, 4) g;
DO $$ DECLARE a int; b int; c int; BEGIN
  SELECT count(*) INTO a FROM gie_staging.claim_discovery_candidates(current_setting('test.bwe_id')::uuid, 3);
  SELECT count(*) INTO b FROM gie_staging.claim_discovery_candidates(current_setting('test.bwe_id')::uuid, 3);
  SELECT count(*) INTO c FROM gie_staging.claim_discovery_candidates(current_setting('test.bwe_id')::uuid, 3);
  IF a <> 3 OR b <> 2 OR c <> 0 THEN RAISE EXCEPTION 'FAILED: queue claims % / % / %', a, b, c; END IF;
  RAISE NOTICE 'ok - queue items are handed out once, in limited slices';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_discovery_candidates (tenant_id, campaign_id, signal_type, query, provider, url, normalized_url, local_date)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_campaign')::uuid, 'buying_intent', 'other query', 'brave', 'https://p1.com/', 'https://p1.com', '2026-11-17');
  RAISE EXCEPTION 'FAILED: same page queued twice';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - a page is queued once per tenant';
END $$;
RESET ROLE;


-- ================================================================ Phase 3: Daily Action Center
-- Fixture: a prospect, a draft, a follow-up and a package with one item for each tenant.
INSERT INTO gie_staging.gie_prospects (tenant_id, opportunity_id, business_name, contact_email, contact_channel)
  SELECT o.tenant_id, o.id, o.business_name, 'hello@' || t.slug || '-biz.com', 'email'
  FROM gie_staging.gie_opportunities o JOIN gie_staging.gie_tenants t ON t.id = o.tenant_id;
INSERT INTO gie_staging.gie_outreach_drafts (tenant_id, prospect_id, channel, subject, body, validation)
  SELECT tenant_id, id, 'email', 'Hello', repeat('x', 100), '{"ok":true,"errors":[],"warnings":[]}' FROM gie_staging.gie_prospects;
INSERT INTO gie_staging.gie_follow_up_tasks (tenant_id, prospect_id, due_date)
  SELECT tenant_id, id, '2026-11-16' FROM gie_staging.gie_prospects;
INSERT INTO gie_staging.gie_daily_action_packages (tenant_id, local_date, ranking_version)
  SELECT id, '2026-11-16', 'ranking-v1' FROM gie_staging.gie_tenants;
INSERT INTO gie_staging.gie_daily_action_items (tenant_id, package_id, rank, kind, opportunity_id, prospect_id, recommended_action, effort, importance, rank_score)
  SELECT p.tenant_id, p.id, 1, 'opportunity', o.id, pr.id, 'Review', 'low', 6, 61
  FROM gie_staging.gie_daily_action_packages p
  JOIN gie_staging.gie_opportunities o ON o.tenant_id = p.tenant_id
  JOIN gie_staging.gie_prospects pr ON pr.tenant_id = p.tenant_id;
INSERT INTO gie_staging.gie_daily_action_events (tenant_id, item_id, event_type, to_status)
  SELECT tenant_id, id, 'created', 'not_started' FROM gie_staging.gie_daily_action_items;
SELECT FROM (SELECT set_config('test.bwe_item', i.id::text, false) FROM gie_staging.gie_daily_action_items i
  JOIN gie_staging.gie_tenants t ON t.id = i.tenant_id WHERE t.slug = 'bwe') x;
SELECT FROM (SELECT set_config('test.bwe_draft', d.id::text, false) FROM gie_staging.gie_outreach_drafts d
  JOIN gie_staging.gie_tenants t ON t.id = d.tenant_id WHERE t.slug = 'bwe') x;
SELECT FROM (SELECT set_config('test.bwe_prospect', p.id::text, false) FROM gie_staging.gie_prospects p
  JOIN gie_staging.gie_tenants t ON t.id = p.tenant_id WHERE t.slug = 'bwe') x;

SET ROLE authenticated;

-- 18. Tenant B's owner sees only tenant B's actions, drafts and follow-ups, and cannot touch tenant A's.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_prospects) AND (SELECT count(*) = 1 FROM gie_staging.gie_outreach_drafts)
  AND (SELECT count(*) = 1 FROM gie_staging.gie_follow_up_tasks) AND (SELECT count(*) = 1 FROM gie_staging.gie_daily_action_items)
  AND (SELECT count(*) = 1 FROM gie_staging.gie_daily_action_packages) AND (SELECT count(*) = 1 FROM gie_staging.gie_daily_action_events),
  'tenant B owner sees only tenant B prospects, drafts, follow-ups, packages, items and events');
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_daily_action_items SET status = 'completed' WHERE id = current_setting('test.bwe_item')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: tenant B owner changed tenant A action'; END IF;
  RAISE NOTICE 'ok - tenant B owner cannot change tenant A actions';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_outreach_drafts SET body = repeat('hacked ', 20) WHERE id = current_setting('test.bwe_draft')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: tenant B owner edited tenant A draft'; END IF;
  RAISE NOTICE 'ok - tenant B owner cannot edit tenant A drafts';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_follow_up_tasks (tenant_id, prospect_id, due_date)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_prospect')::uuid, '2026-11-20');
  RAISE EXCEPTION 'FAILED: tenant B owner created a follow-up in tenant A';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - tenant B owner cannot create follow-ups in tenant A';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_action_events (tenant_id, item_id, event_type)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_item')::uuid, 'note');
  RAISE EXCEPTION 'FAILED: tenant B owner wrote a tenant A event';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - tenant B owner cannot write tenant A events';
END $$;

-- 19. BWE viewer: reads the package, but no drafts or queue, and changes nothing.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_daily_action_items) AND (SELECT count(*) = 1 FROM gie_staging.gie_follow_up_tasks), 'viewer reads the package and follow-ups');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_outreach_drafts), 'viewer cannot read outreach drafts (operators and up)');
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_daily_action_items SET status = 'completed';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: viewer changed an action'; END IF;
  RAISE NOTICE 'ok - viewer cannot change actions';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_action_events (tenant_id, item_id, event_type)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_item')::uuid, 'note');
  RAISE EXCEPTION 'FAILED: viewer wrote an event';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - viewer cannot write events';
END $$;

-- 20. BWE owner: may reword a draft and change an action's status, but cannot approve, forge or rewrite history.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_outreach_drafts SET body = repeat('edited ', 20), edited_by_person = true WHERE id = current_setting('test.bwe_draft')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAILED: owner could not edit own draft'; END IF;
  RAISE NOTICE 'ok - owner can reword a draft';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_outreach_drafts SET status = 'approved', approved_by = auth.uid(), approved_at = now() WHERE id = current_setting('test.bwe_draft')::uuid;
  RAISE EXCEPTION 'FAILED: owner approved a draft directly';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - approval is a server act: owners cannot set it directly';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_outreach_drafts SET validation = '{"ok":true,"errors":[],"warnings":[]}' WHERE id = current_setting('test.bwe_draft')::uuid;
  RAISE EXCEPTION 'FAILED: owner rewrote validation';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - owners cannot rewrite validator results';
END $$;
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_daily_action_items SET status = 'in_progress' WHERE id = current_setting('test.bwe_item')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAILED: owner could not change status'; END IF;
  RAISE NOTICE 'ok - owner can change an action''s status';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_daily_action_items SET rank = 2 WHERE id = current_setting('test.bwe_item')::uuid;
  RAISE EXCEPTION 'FAILED: owner changed an action rank';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - owners cannot re-rank or rewrite actions';
END $$;
INSERT INTO gie_staging.gie_daily_action_events (tenant_id, item_id, actor_user_id, event_type, from_status, to_status)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_item')::uuid, auth.uid(), 'status_changed', 'not_started', 'in_progress');
DO $$ BEGIN
  UPDATE gie_staging.gie_daily_action_events SET to_status = 'completed';
  RAISE EXCEPTION 'FAILED: event rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - action events cannot be rewritten';
END $$;
DO $$ BEGIN
  DELETE FROM gie_staging.gie_daily_action_events;
  RAISE EXCEPTION 'FAILED: events deleted';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - action events cannot be deleted';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_action_packages (tenant_id, local_date, ranking_version)
  VALUES (current_setting('test.bwe_id')::uuid, '2026-11-17', 'x');
  RAISE EXCEPTION 'FAILED: owner created a package';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - packages are built by the server only';
END $$;
-- Follow-ups: operators may schedule and complete them.
INSERT INTO gie_staging.gie_follow_up_tasks (tenant_id, prospect_id, due_date)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_prospect')::uuid, '2026-11-23');
SELECT pg_temp.expect((SELECT count(*) = 2 FROM gie_staging.gie_follow_up_tasks), 'owner can schedule a follow-up');

-- 21. Customers and other sites' users see nothing.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_daily_action_items) AND (SELECT count(*) = 0 FROM gie_staging.gie_prospects) AND (SELECT count(*) = 0 FROM gie_staging.gie_outreach_drafts), 'BWE customer sees no actions, prospects or drafts');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_daily_action_packages) AND (SELECT count(*) = 0 FROM gie_staging.gie_follow_up_tasks), 'other site''s user sees no packages or follow-ups');
RESET ROLE;

-- 22. Server role: one package per local date, at most five ranked items, approval needs a person,
--     and nobody marked do-not-contact can have an approved email.
SET ROLE service_role;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_action_packages (tenant_id, local_date, ranking_version)
  VALUES (current_setting('test.bwe_id')::uuid, '2026-11-16', 'again');
  RAISE EXCEPTION 'FAILED: second package for one date';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - one package per workspace per local date';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_action_items (tenant_id, package_id, rank, kind, follow_up_id, recommended_action, effort, importance, rank_score)
  SELECT p.tenant_id, p.id, 6, 'follow_up', f.id, 'x', 'low', 5, 1
  FROM gie_staging.gie_daily_action_packages p JOIN gie_staging.gie_follow_up_tasks f ON f.tenant_id = p.tenant_id
  WHERE p.tenant_id = current_setting('test.bwe_id')::uuid LIMIT 1;
  RAISE EXCEPTION 'FAILED: a sixth action accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - an action package holds at most five items';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_action_items (tenant_id, package_id, rank, kind, opportunity_id, recommended_action, effort, importance, rank_score)
  SELECT tenant_id, package_id, 2, kind, opportunity_id, 'again', 'low', 5, 1 FROM gie_staging.gie_daily_action_items WHERE id = current_setting('test.bwe_item')::uuid;
  RAISE EXCEPTION 'FAILED: same opportunity twice in a package';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - an opportunity appears once per package';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_outreach_drafts SET status = 'approved' WHERE id = current_setting('test.bwe_draft')::uuid;
  RAISE EXCEPTION 'FAILED: approved without a person';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - approval needs who and when';
END $$;
UPDATE gie_staging.gie_prospects SET do_not_contact = true, do_not_contact_reason = 'asked to stop' WHERE id = current_setting('test.bwe_prospect')::uuid;
DO $$ BEGIN
  UPDATE gie_staging.gie_outreach_drafts SET status = 'approved', approved_by = '00000000-0000-0000-0000-0000000000a1', approved_at = now()
  WHERE id = current_setting('test.bwe_draft')::uuid;
  RAISE EXCEPTION 'FAILED: approved outreach to a do-not-contact prospect';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - no approval for a do-not-contact prospect';
END $$;
UPDATE gie_staging.gie_prospects SET do_not_contact = false WHERE id = current_setting('test.bwe_prospect')::uuid;
UPDATE gie_staging.gie_outreach_drafts SET status = 'approved', approved_by = '00000000-0000-0000-0000-0000000000a1', approved_at = now()
  WHERE id = current_setting('test.bwe_draft')::uuid;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_outreach_drafts (tenant_id, prospect_id, channel, subject, body, validation)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_prospect')::uuid, 'email', 'Second', repeat('y', 100), '{}');
  RAISE EXCEPTION 'FAILED: two live drafts for one prospect';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - one live draft per prospect';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_action_items (tenant_id, package_id, rank, kind, opportunity_id, recommended_action, effort, importance, rank_score)
  SELECT current_setting('test.b_id')::uuid, p.id, 3, 'opportunity', o.id, 'cross', 'low', 5, 1
  FROM gie_staging.gie_daily_action_packages p, gie_staging.gie_opportunities o
  WHERE p.tenant_id = current_setting('test.b_id')::uuid AND o.tenant_id = current_setting('test.bwe_id')::uuid;
  RAISE EXCEPTION 'FAILED: tenant B action pointed at tenant A opportunity';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ok - an action cannot point at another tenant''s opportunity';
END $$;
RESET ROLE;


-- ================================================================ Phase 3 slice 2: sending and replies
INSERT INTO gie_staging.gie_outreach_replies (tenant_id, prospect_id, message_id, from_email, subject, snippet, kind, received_at)
  SELECT tenant_id, id, '<reply-' || tenant_id || '@x.test>', contact_email, 'Re: Hello', 'Sounds good', 'reply', now() FROM gie_staging.gie_prospects;
SELECT FROM (SELECT set_config('test.bwe_reply', r.id::text, false) FROM gie_staging.gie_outreach_replies r
  JOIN gie_staging.gie_tenants t ON t.id = r.tenant_id WHERE t.slug = 'bwe') x;

SET ROLE authenticated;
-- 23. Replies are private to operators of their own workspace.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_outreach_replies), 'tenant B owner sees only tenant B replies');
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_outreach_replies SET status = 'handled' WHERE id = current_setting('test.bwe_reply')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: tenant B owner handled tenant A reply'; END IF;
  RAISE NOTICE 'ok - tenant B owner cannot touch tenant A replies';
END $$;
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_outreach_replies), 'viewer cannot read replies');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_outreach_replies), 'BWE customer sees no replies');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_outreach_replies), 'BWE owner reads own replies');
UPDATE gie_staging.gie_outreach_replies SET status = 'handled' WHERE id = current_setting('test.bwe_reply')::uuid;
SELECT pg_temp.expect((SELECT status = 'handled' FROM gie_staging.gie_outreach_replies), 'owner can mark a reply handled');
DO $$ BEGIN
  UPDATE gie_staging.gie_outreach_replies SET snippet = 'rewritten';
  RAISE EXCEPTION 'FAILED: owner rewrote a reply';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - owners cannot rewrite what a prospect wrote';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_outreach_replies (tenant_id, prospect_id, message_id, from_email, kind, received_at)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_prospect')::uuid, '<forged@x>', 'a@b.co', 'reply', now());
  RAISE EXCEPTION 'FAILED: owner forged a reply';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - replies are written only by the mailbox sync';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_outreach_drafts SET status = 'sent', sent_at = now(), sent_message_id = '<x@y>';
  RAISE EXCEPTION 'FAILED: owner marked a draft sent';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - sending is a server act: owners cannot mark a draft sent';
END $$;
RESET ROLE;

SET ROLE service_role;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_outreach_replies (tenant_id, prospect_id, message_id, from_email, kind, received_at)
  SELECT tenant_id, prospect_id, message_id, from_email, kind, received_at FROM gie_staging.gie_outreach_replies LIMIT 1;
  RAISE EXCEPTION 'FAILED: same message recorded twice';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - a reply is recorded once';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_outreach_drafts SET status = 'sent' WHERE id = current_setting('test.bwe_draft')::uuid;
  RAISE EXCEPTION 'FAILED: sent without a time and message id';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - a sent draft records when and which message';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_outreach_replies (tenant_id, prospect_id, message_id, from_email, kind, received_at)
  VALUES (current_setting('test.b_id')::uuid, current_setting('test.bwe_prospect')::uuid, '<cross@x>', 'a@b.co', 'reply', now());
  RAISE EXCEPTION 'FAILED: tenant B reply pointed at tenant A prospect';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ok - a reply cannot point at another tenant''s prospect';
END $$;
UPDATE gie_staging.gie_outreach_drafts SET status = 'sent', sent_at = now(), sent_message_id = '<ok@y>' WHERE id = current_setting('test.bwe_draft')::uuid;
RESET ROLE;


-- ================================================================ Phase 4: End-of-Day Review
INSERT INTO gie_staging.gie_end_of_day_reviews (tenant_id, local_date, package_id)
  SELECT p.tenant_id, p.local_date, p.id FROM gie_staging.gie_daily_action_packages p;
INSERT INTO gie_staging.gie_end_of_day_review_items (tenant_id, review_id, item_id, recorded_status, recommended_disposition)
  SELECT r.tenant_id, r.id, i.id, 'not_started', 'carry_forward'
  FROM gie_staging.gie_end_of_day_reviews r JOIN gie_staging.gie_daily_action_items i ON i.tenant_id = r.tenant_id AND i.package_id = r.package_id;
INSERT INTO gie_staging.gie_ai_daily_assessments (tenant_id, review_id, summary, model, prompt_version, inputs_hash)
  SELECT tenant_id, id, 'Planned 1 item.', 'claude-opus-5-5', 'assessment-v1', 'abc' FROM gie_staging.gie_end_of_day_reviews;
SELECT FROM (SELECT set_config('test.bwe_review', r.id::text, false) FROM gie_staging.gie_end_of_day_reviews r
  JOIN gie_staging.gie_tenants t ON t.id = r.tenant_id WHERE t.slug = 'bwe') x;
SELECT FROM (SELECT set_config('test.bwe_review_item', r.id::text, false) FROM gie_staging.gie_end_of_day_review_items r
  JOIN gie_staging.gie_tenants t ON t.id = r.tenant_id WHERE t.slug = 'bwe') x;
SELECT FROM (SELECT set_config('test.b_item', i.id::text, false) FROM gie_staging.gie_daily_action_items i
  JOIN gie_staging.gie_tenants t ON t.id = i.tenant_id WHERE t.slug = 'client-b') x;

SET ROLE authenticated;
-- 24. Reviews are per workspace.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_end_of_day_reviews) AND (SELECT count(*) = 1 FROM gie_staging.gie_end_of_day_review_items) AND (SELECT count(*) = 1 FROM gie_staging.gie_ai_daily_assessments), 'tenant B owner sees only tenant B reviews, items and assessments');
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_end_of_day_review_items SET disposition = 'dismiss', note = 'x' WHERE id = current_setting('test.bwe_review_item')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: tenant B owner changed a tenant A review item'; END IF;
  RAISE NOTICE 'ok - tenant B owner cannot decide tenant A review items';
END $$;
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_end_of_day_reviews) AND (SELECT count(*) = 0 FROM gie_staging.gie_ai_daily_assessments), 'BWE customer sees no reviews');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_end_of_day_review_items), 'other site''s user sees no review items');

-- 25. A viewer reads; an owner corrects and decides, but only those columns.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_end_of_day_reviews) AND (SELECT count(*) = 1 FROM gie_staging.gie_ai_daily_assessments), 'viewer reads the review and the assessment');
DO $$ DECLARE n int; BEGIN
  UPDATE gie_staging.gie_end_of_day_review_items SET note = 'x';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAILED: viewer decided a review item'; END IF;
  RAISE NOTICE 'ok - viewer cannot decide review items';
END $$;
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
UPDATE gie_staging.gie_end_of_day_review_items SET corrected_status = 'completed', disposition = 'carry_forward', note = 'done by phone' WHERE id = current_setting('test.bwe_review_item')::uuid;
SELECT pg_temp.expect((SELECT corrected_status = 'completed' AND note = 'done by phone' FROM gie_staging.gie_end_of_day_review_items), 'owner can correct a status and decide');
DO $$ BEGIN
  UPDATE gie_staging.gie_end_of_day_review_items SET recorded_status = 'completed';
  RAISE EXCEPTION 'FAILED: owner rewrote the recorded status';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - the recorded status cannot be rewritten';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_end_of_day_review_items SET applied_at = now();
  RAISE EXCEPTION 'FAILED: owner marked a decision applied';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - applying a decision is a server act';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_end_of_day_reviews SET status = 'finalized', finalized_by = auth.uid(), finalized_at = now();
  RAISE EXCEPTION 'FAILED: owner finalized a review directly';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - finalizing is a server act';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_ai_daily_assessments (tenant_id, review_id, summary, model, prompt_version, inputs_hash)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_review')::uuid, 'forged', 'm', 'v', 'h');
  RAISE EXCEPTION 'FAILED: owner wrote an assessment';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - assessments are written only by the server';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_opportunities SET hold_until = '2027-01-01', priority_multiplier = 1;
  RAISE EXCEPTION 'FAILED: owner placed a hold';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - holds and priority are set by the server only';
END $$;
RESET ROLE;

SET ROLE service_role;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_end_of_day_reviews (tenant_id, local_date) SELECT tenant_id, local_date FROM gie_staging.gie_end_of_day_reviews LIMIT 1;
  RAISE EXCEPTION 'FAILED: second review for one date';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - one review per workspace per local date';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_end_of_day_review_items (tenant_id, review_id, item_id, recorded_status, recommended_disposition)
  SELECT tenant_id, review_id, item_id, recorded_status, recommended_disposition FROM gie_staging.gie_end_of_day_review_items LIMIT 1;
  RAISE EXCEPTION 'FAILED: an item reviewed twice';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - an item is reviewed once';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_end_of_day_review_items (tenant_id, review_id, item_id, recorded_status, recommended_disposition)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_review')::uuid, current_setting('test.b_item')::uuid, 'not_started', 'carry_forward');
  RAISE EXCEPTION 'FAILED: tenant A review pointed at tenant B action';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ok - a review item cannot point at another tenant''s action';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_end_of_day_review_items SET disposition = 'block' WHERE id = current_setting('test.bwe_review_item')::uuid;
  RAISE EXCEPTION 'FAILED: block without a date';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - reschedule and block need a date';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_opportunities SET hold_until = '2027-01-01';
  RAISE EXCEPTION 'FAILED: hold without a reason';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - a hold records its reason';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_end_of_day_reviews SET status = 'finalized' WHERE id = current_setting('test.bwe_review')::uuid;
  RAISE EXCEPTION 'FAILED: finalized without who and when';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - finalizing records who and when';
END $$;
UPDATE gie_staging.gie_end_of_day_reviews SET status = 'finalized', finalized_by = '00000000-0000-0000-0000-0000000000a1', finalized_at = now()
  WHERE id = current_setting('test.bwe_review')::uuid;
DO $$ BEGIN
  UPDATE gie_staging.gie_end_of_day_reviews SET tomorrow_plan = '[]' WHERE id = current_setting('test.bwe_review')::uuid;
  RAISE EXCEPTION 'FAILED: finalized review changed';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - a finalized review is locked';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_end_of_day_review_items SET note = 'later' WHERE id = current_setting('test.bwe_review_item')::uuid;
  RAISE EXCEPTION 'FAILED: finalized review item changed';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - a finalized review''s items are locked';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_ai_daily_assessments SET summary = 'rewritten';
  RAISE EXCEPTION 'FAILED: assessment rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - assessments cannot be rewritten';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_ai_daily_assessments (tenant_id, review_id, summary, model, prompt_version, inputs_hash)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_review')::uuid, 'second', 'm', 'v', 'h');
  RAISE EXCEPTION 'FAILED: two assessments for one review';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - one assessment per review';
END $$;
RESET ROLE;


-- ================================================================ Phase 5: Daily Effectiveness Score
INSERT INTO gie_staging.gie_effectiveness_scoring_rules (tenant_id, version, rules)
  SELECT id, 'des-v1', '{"version":"des-v1"}'::jsonb FROM gie_staging.gie_tenants ON CONFLICT (tenant_id, version) DO NOTHING;
INSERT INTO gie_staging.gie_daily_effectiveness_scores (tenant_id, local_date, review_id, rule_version, rules, available, score, band, completeness)
  SELECT tenant_id, local_date, id, 'des-v1', '{"version":"des-v1"}'::jsonb, true, 72, 'Productive', 60 FROM gie_staging.gie_end_of_day_reviews;
INSERT INTO gie_staging.gie_effectiveness_score_components (tenant_id, score_id, component, weight, measured, points, explanation)
  SELECT tenant_id, id, 'priority_execution', 10, true, 8, '1 of 1 actions completed.' FROM gie_staging.gie_daily_effectiveness_scores;
INSERT INTO gie_staging.gie_effectiveness_score_events (tenant_id, score_id, component, event_type, source_table, source_id, points)
  SELECT s.tenant_id, s.id, 'priority_execution', 'action_completed', 'gie_daily_action_items', i.id, 8
  FROM gie_staging.gie_daily_effectiveness_scores s JOIN gie_staging.gie_daily_action_items i ON i.tenant_id = s.tenant_id;
SELECT FROM (SELECT set_config('test.bwe_score', s.id::text, false) FROM gie_staging.gie_daily_effectiveness_scores s
  JOIN gie_staging.gie_tenants t ON t.id = s.tenant_id WHERE t.slug = 'bwe') x;
SELECT FROM (SELECT set_config('test.b_review', r.id::text, false) FROM gie_staging.gie_end_of_day_reviews r
  JOIN gie_staging.gie_tenants t ON t.id = r.tenant_id WHERE t.slug = 'client-b') x;

SET ROLE authenticated;
-- 26. Scores are per workspace and read-only for everyone signed in.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_daily_effectiveness_scores) AND (SELECT count(*) = 1 FROM gie_staging.gie_effectiveness_score_components)
  AND (SELECT count(*) = 1 FROM gie_staging.gie_effectiveness_score_events) AND (SELECT count(*) = 1 FROM gie_staging.gie_effectiveness_scoring_rules), 'tenant B owner sees only tenant B scores, components, evidence and rules');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_daily_effectiveness_scores) AND (SELECT count(*) = 1 FROM gie_staging.gie_effectiveness_score_events), 'viewer reads scores and evidence');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_daily_effectiveness_scores) AND (SELECT count(*) = 0 FROM gie_staging.gie_effectiveness_scoring_rules), 'BWE customer sees no scores');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_effectiveness_score_components), 'other site''s user sees no score components');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
DO $$ BEGIN
  UPDATE gie_staging.gie_daily_effectiveness_scores SET score = 100;
  RAISE EXCEPTION 'FAILED: owner edited a score';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - owners cannot edit a score';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_effectiveness_scores (tenant_id, local_date, review_id, rule_version, rules, available, score, band, completeness)
  VALUES (current_setting('test.bwe_id')::uuid, '2026-12-01', current_setting('test.bwe_review')::uuid, 'des-v1', '{}', true, 99, 'Exceptional', 100);
  RAISE EXCEPTION 'FAILED: owner wrote a score';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - scores are written only by the server';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_effectiveness_scoring_rules (tenant_id, version, rules) VALUES (current_setting('test.bwe_id')::uuid, 'des-v2', '{}');
  RAISE EXCEPTION 'FAILED: owner changed the scoring rules';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - scoring rules are not editable by users';
END $$;
-- Handling a reply stamps when, and the client cannot choose the time.
DO $$ BEGIN
  UPDATE gie_staging.gie_outreach_replies SET handled_at = now();
  RAISE EXCEPTION 'FAILED: owner set handled_at';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - the handled time is stamped by the database, not chosen';
END $$;
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
UPDATE gie_staging.gie_outreach_replies SET status = 'handled';
SELECT pg_temp.expect((SELECT handled_at IS NOT NULL FROM gie_staging.gie_outreach_replies), 'handling a reply stamps the time');
DO $$ BEGIN
  UPDATE gie_staging.gie_outreach_replies SET status = 'new';
  RAISE EXCEPTION 'FAILED: a handled reply was reopened';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - a handled reply cannot be reopened';
END $$;
RESET ROLE;

SET ROLE service_role;
DO $$ BEGIN
  UPDATE gie_staging.gie_daily_effectiveness_scores SET score = 100;
  RAISE EXCEPTION 'FAILED: score rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - a finalized score cannot be rewritten, even by the server';
END $$;
DO $$ BEGIN
  DELETE FROM gie_staging.gie_daily_effectiveness_scores;
  RAISE EXCEPTION 'FAILED: score deleted';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - a finalized score cannot be deleted';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_effectiveness_score_events SET points = 99;
  RAISE EXCEPTION 'FAILED: evidence rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - score evidence cannot be rewritten';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_effectiveness_scores (tenant_id, local_date, review_id, rule_version, rules, available, score, band, completeness)
  SELECT tenant_id, local_date, review_id, rule_version, rules, available, score, band, completeness FROM gie_staging.gie_daily_effectiveness_scores LIMIT 1;
  RAISE EXCEPTION 'FAILED: second score for one date';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - one score per workspace per local date';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_effectiveness_scores (tenant_id, local_date, review_id, rule_version, rules, available, completeness, unavailable_reason)
  VALUES (current_setting('test.bwe_id')::uuid, '2026-12-02', current_setting('test.bwe_review')::uuid, 'des-v1', '{}', false, 0, NULL);
  RAISE EXCEPTION 'FAILED: unavailable without a reason';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - an unavailable score always says why';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_effectiveness_scores (tenant_id, local_date, review_id, rule_version, rules, available, score, band, completeness, unavailable_reason)
  VALUES (current_setting('test.bwe_id')::uuid, '2026-12-03', current_setting('test.bwe_review')::uuid, 'des-v1', '{}', false, 0, 'Low', 20, 'thin');
  RAISE EXCEPTION 'FAILED: unavailable stored as a zero';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - unavailable is never stored as a score';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_daily_effectiveness_scores (tenant_id, local_date, review_id, rule_version, rules, available, score, band, completeness)
  VALUES (current_setting('test.bwe_id')::uuid, '2026-12-04', current_setting('test.b_review')::uuid, 'des-v1', '{}', true, 50, 'Needs Improvement', 80);
  RAISE EXCEPTION 'FAILED: score pointed at another tenant''s review';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ok - a score cannot point at another tenant''s review';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_effectiveness_score_components (tenant_id, score_id, component, weight, measured, points, explanation)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_score')::uuid, 'action_quality', 25, false, 5, 'x');
  RAISE EXCEPTION 'FAILED: unmeasured component with points';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - a component is measured or not, never both';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_effectiveness_score_components (tenant_id, score_id, component, weight, measured, points, explanation)
  VALUES (current_setting('test.bwe_id')::uuid, current_setting('test.bwe_score')::uuid, 'action_quality', 25, true, 26, 'x');
  RAISE EXCEPTION 'FAILED: points above the weight';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - points cannot exceed a component''s weight';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_effectiveness_score_events (tenant_id, score_id, component, event_type, source_table, source_id, points)
  SELECT tenant_id, score_id, component, event_type, source_table, source_id, points FROM gie_staging.gie_effectiveness_score_events LIMIT 1;
  RAISE EXCEPTION 'FAILED: one event earned points twice';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - each event earns points once per component';
END $$;
RESET ROLE;

-- ================================================================ Phase 6: 30-Day Growth Performance
INSERT INTO gie_staging.gie_sales_funnel_events (tenant_id, stage, occurred_at, source_table, source_id, prospect_id, attribution, attribution_confidence, attribution_basis)
  SELECT tenant_id, 'lead', now(), 'leads', gen_random_uuid(), id, 'first_touch', 'high', 'The lead is linked to this prospect.' FROM gie_staging.gie_prospects;
INSERT INTO gie_staging.gie_revenue_events (tenant_id, payment_id, paid_at, kind, amount_cents, currency)
  SELECT tenant_id, gen_random_uuid(), now(), 'deposit', 50000, 'usd' FROM gie_staging.gie_prospects;
INSERT INTO gie_staging.gie_growth_period_snapshots (tenant_id, as_of_date, window_days, min_events, report)
  SELECT id, '2026-11-18', 30, 10, '{}'::jsonb FROM gie_staging.gie_tenants;

SET ROLE authenticated;
-- 27. Outcomes and frozen reports are per workspace and read-only for everyone signed in.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT count(*) FROM gie_staging.gie_sales_funnel_events WHERE tenant_id <> current_setting('test.b_id')::uuid) = 0
  AND (SELECT count(*) FROM gie_staging.gie_revenue_events WHERE tenant_id <> current_setting('test.b_id')::uuid) = 0
  AND (SELECT count(*) FROM gie_staging.gie_growth_period_snapshots) = 1, 'tenant B owner sees only tenant B outcomes and reports');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect((SELECT count(*) >= 1 FROM gie_staging.gie_sales_funnel_events) AND (SELECT count(*) >= 1 FROM gie_staging.gie_revenue_events), 'viewer reads outcomes');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
SELECT pg_temp.expect((SELECT count(*) FROM gie_staging.gie_sales_funnel_events) = 0 AND (SELECT count(*) FROM gie_staging.gie_revenue_events) = 0
  AND (SELECT count(*) FROM gie_staging.gie_growth_period_snapshots) = 0, 'BWE customer sees no outcomes');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
SELECT pg_temp.expect((SELECT count(*) FROM gie_staging.gie_growth_period_snapshots) = 0, 'other site''s user sees no growth reports');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
DO $$ BEGIN
  INSERT INTO gie_staging.gie_revenue_events (tenant_id, payment_id, paid_at, kind, amount_cents, currency)
  VALUES (current_setting('test.bwe_id')::uuid, gen_random_uuid(), now(), 'deposit', 1, 'usd');
  RAISE EXCEPTION 'FAILED: owner recorded revenue';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - revenue is recorded only by the server';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_growth_period_snapshots SET report = '{"edited":true}';
  RAISE EXCEPTION 'FAILED: owner edited a report';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - users cannot edit a frozen report';
END $$;
RESET ROLE;

SET ROLE service_role;
DO $$ BEGIN
  UPDATE gie_staging.gie_sales_funnel_events SET occurred_at = now() - interval '1 day';
  RAISE EXCEPTION 'FAILED: outcome date rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - when an outcome happened cannot be rewritten';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_revenue_events SET amount_cents = 1;
  RAISE EXCEPTION 'FAILED: revenue amount rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - a revenue amount cannot be rewritten';
END $$;
DO $$ BEGIN
  DELETE FROM gie_staging.gie_sales_funnel_events;
  RAISE EXCEPTION 'FAILED: outcome deleted';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - recorded outcomes cannot be deleted';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_growth_period_snapshots SET report = '{}';
  RAISE EXCEPTION 'FAILED: report rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - a frozen report cannot be rewritten, even by the server';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_growth_period_snapshots (tenant_id, as_of_date, window_days, min_events, report)
  VALUES (current_setting('test.bwe_id')::uuid, '2026-11-18', 30, 10, '{}');
  RAISE EXCEPTION 'FAILED: second report for one date';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - one frozen report per workspace per date';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_revenue_events (tenant_id, payment_id, paid_at, kind, amount_cents, currency)
  SELECT tenant_id, payment_id, paid_at, kind, amount_cents, currency FROM gie_staging.gie_revenue_events LIMIT 1;
  RAISE EXCEPTION 'FAILED: one payment counted twice';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - a payment is revenue once';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_sales_funnel_events (tenant_id, stage, occurred_at, source_table, source_id)
  SELECT tenant_id, stage, occurred_at, source_table, source_id FROM gie_staging.gie_sales_funnel_events LIMIT 1;
  RAISE EXCEPTION 'FAILED: one source row counted twice';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - one source row yields one event per stage';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_sales_funnel_events (tenant_id, stage, occurred_at, source_table, source_id, attribution, attribution_confidence, attribution_basis)
  VALUES (current_setting('test.bwe_id')::uuid, 'lead', now(), 'leads', gen_random_uuid(), 'first_touch', 'none', 'x');
  RAISE EXCEPTION 'FAILED: attributed with no confidence';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - unknown attribution and no confidence go together';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_sales_funnel_events (tenant_id, stage, occurred_at, source_table, source_id, attribution, attribution_confidence)
  VALUES (current_setting('test.bwe_id')::uuid, 'lead', now(), 'leads', gen_random_uuid(), 'assisted', 'medium');
  RAISE EXCEPTION 'FAILED: attribution without a basis';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - an attribution always says how it was found';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_sales_funnel_events (tenant_id, stage, occurred_at, source_table, source_id, prospect_id)
  VALUES (current_setting('test.bwe_id')::uuid, 'lead', now(), 'leads', gen_random_uuid(), (SELECT id FROM gie_staging.gie_prospects WHERE tenant_id = current_setting('test.b_id')::uuid LIMIT 1));
  RAISE EXCEPTION 'FAILED: outcome pointed at another tenant''s prospect';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ok - an outcome cannot point at another tenant''s prospect';
END $$;
-- A link that appears later may refresh the attribution, and only the attribution.
UPDATE gie_staging.gie_sales_funnel_events SET attribution = 'assisted', attribution_confidence = 'medium', attribution_basis = 'Refreshed.' WHERE tenant_id = current_setting('test.bwe_id')::uuid;
SELECT pg_temp.expect((SELECT bool_and(attribution = 'assisted') FROM gie_staging.gie_sales_funnel_events WHERE tenant_id = current_setting('test.bwe_id')::uuid), 'attribution can be refreshed when a link appears');
RESET ROLE;

-- ================================================================ Phase 7: continuous improvement
INSERT INTO gie_staging.gie_recommendations (tenant_id, rule_key, subject_key, title, rationale, evidence, metric)
  SELECT id, 'growth_flag', 'A', 'Review who the outreach is going to', 'Why.', '[{"label":"l","value":"v","source":"s"}]'::jsonb, 'lead' FROM gie_staging.gie_tenants;
SELECT FROM (SELECT set_config('test.bwe_rec', r.id::text, false) FROM gie_staging.gie_recommendations r WHERE r.tenant_id = current_setting('test.bwe_id')::uuid) x;

SET ROLE authenticated;
-- 28. Suggestions are per workspace and read-only for everyone signed in.
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT count(*) FROM gie_staging.gie_recommendations) = 1 AND (SELECT count(*) FROM gie_staging.gie_recommendations WHERE tenant_id <> current_setting('test.b_id')::uuid) = 0, 'tenant B owner sees only tenant B suggestions');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect((SELECT count(*) FROM gie_staging.gie_recommendations) >= 1, 'viewer reads suggestions');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
SELECT pg_temp.expect((SELECT count(*) FROM gie_staging.gie_recommendations) = 0, 'BWE customer sees no suggestions');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
SELECT pg_temp.expect((SELECT count(*) FROM gie_staging.gie_recommendations) = 0, 'other site''s user sees no suggestions');
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
DO $$ BEGIN
  UPDATE gie_staging.gie_recommendations SET status = 'approved', decided_at = now();
  RAISE EXCEPTION 'FAILED: owner approved directly';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - decisions go through the server, not straight into the table';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_recommendations (tenant_id, rule_key, subject_key, title, rationale, evidence, metric)
  VALUES (current_setting('test.bwe_id')::uuid, 'growth_flag', 'B', 't', 'r', '[{"label":"l"}]', 'lead');
  RAISE EXCEPTION 'FAILED: owner wrote a suggestion';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - suggestions are written only by the server';
END $$;
RESET ROLE;

SET ROLE service_role;
DO $$ BEGIN
  UPDATE gie_staging.gie_recommendations SET title = 'Something else';
  RAISE EXCEPTION 'FAILED: suggestion rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - what was suggested cannot be rewritten';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_recommendations SET evidence = '[{"label":"fake"}]';
  RAISE EXCEPTION 'FAILED: evidence rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - the evidence cannot be rewritten';
END $$;
DO $$ BEGIN
  DELETE FROM gie_staging.gie_recommendations;
  RAISE EXCEPTION 'FAILED: suggestion deleted';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - suggestions are never deleted';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_recommendations SET status = 'implemented', implemented_at = now(), decided_at = now(), baseline = '{"value":1}';
  RAISE EXCEPTION 'FAILED: skipped approval';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - a suggestion cannot be carried out before it is approved';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_recommendations SET status = 'approved';
  RAISE EXCEPTION 'FAILED: approved without a decision time';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - an approval always has a time';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_recommendations (tenant_id, rule_key, subject_key, title, rationale, evidence, metric)
  VALUES (current_setting('test.bwe_id')::uuid, 'growth_flag', 'A', 't', 'r', '[{"label":"l"}]', 'lead');
  RAISE EXCEPTION 'FAILED: two open suggestions for one subject';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok - one open suggestion per rule and subject';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_recommendations (tenant_id, rule_key, subject_key, title, rationale, evidence, metric)
  VALUES (current_setting('test.bwe_id')::uuid, 'growth_flag', 'Z', 't', 'r', '[]', 'lead');
  RAISE EXCEPTION 'FAILED: suggestion without evidence';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - a suggestion must carry evidence';
END $$;
DO $$ BEGIN
  INSERT INTO gie_staging.gie_recommendations (tenant_id, rule_key, subject_key, title, rationale, evidence, metric, campaign_id)
  VALUES (current_setting('test.bwe_id')::uuid, 'growth_flag', 'Y', 't', 'r', '[{"label":"l"}]', 'lead', gen_random_uuid());
  RAISE EXCEPTION 'FAILED: suggestion pointed at a missing campaign';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ok - a suggestion cannot point at a campaign outside the workspace';
END $$;
-- The honest path: approve, carry out with a baseline, measure once.
UPDATE gie_staging.gie_recommendations SET status = 'approved', decided_at = now() WHERE id = current_setting('test.bwe_rec')::uuid;
UPDATE gie_staging.gie_recommendations SET status = 'implemented', implemented_at = now(), baseline = '{"value":3}' WHERE id = current_setting('test.bwe_rec')::uuid;
DO $$ BEGIN
  UPDATE gie_staging.gie_recommendations SET baseline = '{"value":99}' WHERE id = current_setting('test.bwe_rec')::uuid;
  RAISE EXCEPTION 'FAILED: baseline rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - the baseline cannot be changed after the fact';
END $$;
UPDATE gie_staging.gie_recommendations SET outcome = '{"verdict":"improved"}', outcome_at = now() WHERE id = current_setting('test.bwe_rec')::uuid;
DO $$ BEGIN
  UPDATE gie_staging.gie_recommendations SET outcome = '{"verdict":"worse"}' WHERE id = current_setting('test.bwe_rec')::uuid;
  RAISE EXCEPTION 'FAILED: outcome rewritten';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - a measured outcome is written once';
END $$;
DO $$ BEGIN
  UPDATE gie_staging.gie_recommendations SET status = 'rejected' WHERE id = current_setting('test.bwe_rec')::uuid;
  RAISE EXCEPTION 'FAILED: carried-out suggestion rejected';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - a carried-out suggestion cannot be un-done in the record';
END $$;
RESET ROLE;

-- ================================================================ Phase 8: agency readiness
-- 29. Structural checks that apply to every GIE table, present and future.
DO $$
DECLARE r record; bad text := '';
BEGIN
  FOR r IN SELECT c.oid, c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'gie_staging' AND c.relkind = 'r' LOOP
    IF NOT r.relrowsecurity THEN bad := bad || ' no-RLS:' || r.relname; END IF;
    IF r.relname <> 'gie_tenants' AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = r.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) THEN
      bad := bad || ' no-tenant_id:' || r.relname;
    END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'FAILED: tables without isolation:%', bad; END IF;
  RAISE NOTICE 'ok - every GIE table has RLS and a tenant_id';
END $$;
DO $$
DECLARE r record; bad text := '';
BEGIN
  -- No policy may let a role in on "signed in" alone: each must go through has_tenant_role.
  FOR r IN SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'gie_staging' LOOP
    IF coalesce(r.qual, '') NOT LIKE '%has_tenant_role%' AND coalesce(r.with_check, '') NOT LIKE '%has_tenant_role%' THEN
      bad := bad || ' ' || r.tablename || '/' || r.policyname;
    END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'FAILED: policies not tied to has_tenant_role:%', bad; END IF;
  RAISE NOTICE 'ok - every policy goes through has_tenant_role';
END $$;

-- 30. A suspended workspace stops working for its members, and a platform admin keeps access.
UPDATE gie_staging.gie_tenants SET status = 'suspended' WHERE slug = 'client-b';
SET ROLE authenticated;
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT count(*) = 0 FROM gie_staging.gie_tenants) AND (SELECT count(*) = 0 FROM gie_staging.gie_prospects)
  AND (SELECT count(*) = 0 FROM gie_staging.gie_recommendations) AND (SELECT count(*) = 0 FROM gie_staging.gie_growth_period_snapshots), 'a suspended workspace''s owner sees nothing');
SELECT pg_temp.act_as('00000000-0000-0000-0000-00000000000a', 'aal2');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_tenants WHERE slug = 'client-b'), 'a platform admin can still see a suspended workspace');
RESET ROLE;
UPDATE gie_staging.gie_tenants SET status = 'active' WHERE slug = 'client-b';
SET ROLE authenticated;
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_tenants), 'reactivating restores access');
RESET ROLE;

-- 31. Limits are enforced by the database.
SELECT FROM (SELECT set_config('test.b_id2', id::text, false) FROM gie_staging.gie_tenants WHERE slug = 'client-b') x;
INSERT INTO gie_staging.gie_tenant_quotas (tenant_id, max_active_campaigns, max_members, daily_send_cap)
  VALUES (current_setting('test.b_id2')::uuid, 3, 1, 5) ON CONFLICT (tenant_id) DO UPDATE SET max_active_campaigns = 3, max_members = 1, daily_send_cap = 5;
SET ROLE service_role;
INSERT INTO gie_staging.gie_campaigns (tenant_id, name, status) VALUES (current_setting('test.b_id2')::uuid, 'q1', 'active'), (current_setting('test.b_id2')::uuid, 'q2', 'active');
DO $$ BEGIN
  INSERT INTO gie_staging.gie_campaigns (tenant_id, name, status) VALUES (current_setting('test.b_id2')::uuid, 'q3', 'active');
  RAISE EXCEPTION 'FAILED: third active campaign allowed';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - the active campaign limit is enforced';
END $$;
INSERT INTO gie_staging.gie_campaigns (tenant_id, name, status) VALUES (current_setting('test.b_id2')::uuid, 'q-draft', 'draft');
DO $$ BEGIN
  UPDATE gie_staging.gie_campaigns SET status = 'active' WHERE name = 'q-draft';
  RAISE EXCEPTION 'FAILED: draft activated past the limit';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - activating a draft counts against the limit too';
END $$;
UPDATE gie_staging.gie_campaigns SET status = 'paused' WHERE name = 'q1';
UPDATE gie_staging.gie_campaigns SET status = 'active' WHERE name = 'q-draft';
DO $$ BEGIN
  INSERT INTO gie_staging.gie_tenant_memberships (tenant_id, user_id, role) VALUES (current_setting('test.b_id2')::uuid, '00000000-0000-0000-0000-0000000000a2', 'viewer');
  RAISE EXCEPTION 'FAILED: member limit ignored';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok - the team size limit is enforced';
END $$;
RESET ROLE;
SET ROLE authenticated;
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.expect((SELECT daily_send_cap = 5 FROM gie_staging.gie_tenant_quotas), 'members can read their own limits');
DO $$ BEGIN
  UPDATE gie_staging.gie_tenant_quotas SET max_members = 100;
  RAISE EXCEPTION 'FAILED: owner raised their own limit';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok - a workspace cannot raise its own limits';
END $$;
SELECT pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect((SELECT count(*) = 1 FROM gie_staging.gie_tenant_quotas WHERE tenant_id = current_setting('test.bwe_id')::uuid) AND (SELECT count(*) = 0 FROM gie_staging.gie_tenant_quotas WHERE tenant_id = current_setting('test.b_id2')::uuid), 'limits are visible only to their own workspace');
RESET ROLE;

SELECT 'ALL DATABASE TESTS PASSED' AS result;
