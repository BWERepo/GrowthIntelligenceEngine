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

SELECT 'ALL DATABASE TESTS PASSED' AS result;
