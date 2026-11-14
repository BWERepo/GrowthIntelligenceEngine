-- Growth Intelligence Engine: Phase 5, Daily Effectiveness Score. Needs the Phase 4 migration.
--
-- A finalized day's score is stored once, with the rule set it used, its
-- components, and the events that earned each point, and is never rewritten.
-- Provisional scores for unfinished days are computed on request and not stored.

-- Replies record when a person handled them (set by a trigger, never by the client),
-- so "handled within one business day" can be measured.
ALTER TABLE __SCHEMA__.gie_outreach_replies ADD COLUMN handled_at timestamptz;
CREATE FUNCTION __SCHEMA__.stamp_reply_handled()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'handled' AND OLD.status = 'new' THEN
    NEW.handled_at := now();
  ELSIF NEW.status = 'new' AND OLD.status = 'handled' THEN
    RAISE EXCEPTION 'A handled reply cannot be reopened' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gie_outreach_replies_handled BEFORE UPDATE ON __SCHEMA__.gie_outreach_replies
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.stamp_reply_handled();

CREATE TABLE __SCHEMA__.gie_effectiveness_scoring_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  version text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 40),
  rules jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- A rule change is a new version, never an edit.
  UNIQUE (tenant_id, version)
);

CREATE TABLE __SCHEMA__.gie_daily_effectiveness_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  review_id uuid NOT NULL,
  rule_version text NOT NULL CHECK (char_length(rule_version) BETWEEN 1 AND 40),
  -- The exact rules used, so the score can be reproduced after the rules change.
  rules jsonb NOT NULL,
  available boolean NOT NULL,
  score smallint CHECK (score BETWEEN 0 AND 100),
  band text CHECK (char_length(band) <= 40),
  -- Percent of the 100 points that could be measured that day.
  completeness smallint NOT NULL CHECK (completeness BETWEEN 0 AND 100),
  unavailable_reason text CHECK (char_length(unavailable_reason) <= 400),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, local_date),
  FOREIGN KEY (tenant_id, review_id) REFERENCES __SCHEMA__.gie_end_of_day_reviews (tenant_id, id),
  -- Unavailable is never stored as a zero, and an available score is never blank.
  CHECK (available = (score IS NOT NULL)),
  CHECK (available = (band IS NOT NULL)),
  CHECK (available OR unavailable_reason IS NOT NULL)
);

CREATE TABLE __SCHEMA__.gie_effectiveness_score_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  score_id uuid NOT NULL,
  component text NOT NULL CHECK (component IN ('business_outcomes', 'action_quality', 'follow_up_discipline', 'priority_execution', 'opportunity_management')),
  weight smallint NOT NULL CHECK (weight BETWEEN 0 AND 100),
  measured boolean NOT NULL,
  points numeric(6, 2) CHECK (points >= 0 AND points <= weight),
  explanation text NOT NULL CHECK (char_length(explanation) BETWEEN 1 AND 500),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, score_id, component),
  FOREIGN KEY (tenant_id, score_id) REFERENCES __SCHEMA__.gie_daily_effectiveness_scores (tenant_id, id) ON DELETE CASCADE,
  CHECK (measured = (points IS NOT NULL))
);

-- Which recorded event earned which points.
CREATE TABLE __SCHEMA__.gie_effectiveness_score_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  score_id uuid NOT NULL,
  component text NOT NULL CHECK (component IN ('business_outcomes', 'action_quality', 'follow_up_discipline', 'priority_execution', 'opportunity_management')),
  event_type text NOT NULL CHECK (char_length(event_type) <= 60),
  source_table text NOT NULL CHECK (char_length(source_table) <= 60),
  source_id uuid NOT NULL,
  points numeric(6, 2) NOT NULL CHECK (points >= 0),
  UNIQUE (tenant_id, id),
  -- Each source row earns points once per component.
  UNIQUE (tenant_id, score_id, component, source_table, source_id),
  FOREIGN KEY (tenant_id, score_id) REFERENCES __SCHEMA__.gie_daily_effectiveness_scores (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX gie_effectiveness_score_events_source_idx ON __SCHEMA__.gie_effectiveness_score_events (tenant_id, source_table, source_id);

-- Stored scores, their rules, components and evidence never change.
CREATE TRIGGER gie_effectiveness_rules_immutable BEFORE UPDATE ON __SCHEMA__.gie_effectiveness_scoring_rules
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.forbid_change();
CREATE TRIGGER gie_daily_effectiveness_scores_immutable BEFORE UPDATE ON __SCHEMA__.gie_daily_effectiveness_scores
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.forbid_change();
CREATE TRIGGER gie_effectiveness_components_immutable BEFORE UPDATE ON __SCHEMA__.gie_effectiveness_score_components
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.forbid_change();
CREATE TRIGGER gie_effectiveness_events_immutable BEFORE UPDATE ON __SCHEMA__.gie_effectiveness_score_events
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.forbid_change();

ALTER TABLE __SCHEMA__.gie_effectiveness_scoring_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_daily_effectiveness_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_effectiveness_score_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_effectiveness_score_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read scoring rules" ON __SCHEMA__.gie_effectiveness_scoring_rules
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Members read effectiveness scores" ON __SCHEMA__.gie_daily_effectiveness_scores
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Members read score components" ON __SCHEMA__.gie_effectiveness_score_components
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Members read score events" ON __SCHEMA__.gie_effectiveness_score_events
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));

GRANT SELECT ON
  __SCHEMA__.gie_effectiveness_scoring_rules, __SCHEMA__.gie_daily_effectiveness_scores,
  __SCHEMA__.gie_effectiveness_score_components, __SCHEMA__.gie_effectiveness_score_events
  TO authenticated;
GRANT ALL ON
  __SCHEMA__.gie_effectiveness_scoring_rules, __SCHEMA__.gie_daily_effectiveness_scores,
  __SCHEMA__.gie_effectiveness_score_components, __SCHEMA__.gie_effectiveness_score_events
  TO service_role;
-- A written score is a permanent record: the server can add, never alter or remove.
REVOKE UPDATE, DELETE, TRUNCATE ON
  __SCHEMA__.gie_effectiveness_scoring_rules, __SCHEMA__.gie_daily_effectiveness_scores,
  __SCHEMA__.gie_effectiveness_score_components, __SCHEMA__.gie_effectiveness_score_events
  FROM service_role;

-- The first rule set for every workspace that exists now; the server adds it for new ones.
INSERT INTO __SCHEMA__.gie_effectiveness_scoring_rules (tenant_id, version, rules)
SELECT id, 'des-v1', '{"version":"des-v1","weights":{"business_outcomes":40,"action_quality":25,"follow_up_discipline":15,"priority_execution":10,"opportunity_management":10},"minCompleteness":0.5,"contactChecks":{"verified":0.25,"validatorPassed":0.35,"editedByPerson":0.2,"notDuplicate":0.2},"bands":[{"min":90,"label":"Exceptional"},{"min":75,"label":"Highly Effective"},{"min":60,"label":"Productive"},{"min":40,"label":"Needs Improvement"},{"min":0,"label":"Low"}]}'::jsonb
FROM __SCHEMA__.gie_tenants;

NOTIFY pgrst, 'reload schema';
