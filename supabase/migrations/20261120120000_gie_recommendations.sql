-- Growth Intelligence Engine: Phase 7, continuous improvement. Needs the Phase 6 migration.
--
-- A recommendation is a suggestion with the recorded evidence behind it. A person approves
-- or rejects it and later says they carried it out. Nothing here changes a campaign: the
-- app only ever writes this table, and the person makes the change themselves.
-- Once implemented, the same measures are read again for the following 30 days and the
-- result is stored once, with the baseline taken at the time.

CREATE TABLE __SCHEMA__.gie_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  rule_key text NOT NULL CHECK (rule_key IN ('campaign_no_replies', 'campaign_outperforms', 'campaign_finds_nothing', 'growth_flag')),
  -- What the suggestion is about (a campaign id or a flag letter): one open suggestion per rule and subject.
  subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 80),
  campaign_id uuid,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 1000),
  -- Recorded facts only: [{"label": "...", "value": "...", "source": "..."}].
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) >= 1),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'implemented')),
  -- The measure that decides whether it worked, and its value before the change.
  metric text NOT NULL CHECK (metric IN ('replied', 'opportunity', 'lead')),
  baseline jsonb,
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text CHECK (char_length(decision_note) <= 500),
  implemented_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  implemented_at timestamptz,
  implementation_note text CHECK (char_length(implementation_note) <= 500),
  -- Written once, 30 days after implementation.
  outcome jsonb,
  outcome_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES __SCHEMA__.gie_campaigns (tenant_id, id) ON DELETE SET NULL (campaign_id),
  -- A decision is a person's act and has a time (the person's id is kept unless their account is deleted).
  CHECK (status = 'proposed' OR decided_at IS NOT NULL),
  CHECK (status <> 'implemented' OR (implemented_at IS NOT NULL AND baseline IS NOT NULL)),
  CHECK (outcome IS NULL OR (status = 'implemented' AND outcome_at IS NOT NULL))
);
CREATE INDEX gie_recommendations_tenant_idx ON __SCHEMA__.gie_recommendations (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX gie_recommendations_one_open_idx ON __SCHEMA__.gie_recommendations (tenant_id, rule_key, subject_key) WHERE status IN ('proposed', 'approved');

CREATE FUNCTION __SCHEMA__.guard_recommendation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- What was suggested, and why, never changes.
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.rule_key <> OLD.rule_key OR NEW.subject_key <> OLD.subject_key
     OR NEW.title <> OLD.title OR NEW.rationale <> OLD.rationale OR NEW.evidence <> OLD.evidence
     OR NEW.metric <> OLD.metric OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A recommendation''s content cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status IN ('implemented', 'rejected'))) THEN
    RAISE EXCEPTION 'A % recommendation cannot become %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('rejected', 'implemented') AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_note IS DISTINCT FROM OLD.decision_note) THEN
    RAISE EXCEPTION 'A recorded decision cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.baseline IS NOT NULL AND NEW.baseline IS DISTINCT FROM OLD.baseline THEN
    RAISE EXCEPTION 'The baseline cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.outcome_at IS DISTINCT FROM OLD.outcome_at) THEN
    RAISE EXCEPTION 'A measured outcome cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.implemented_at IS NOT NULL AND (NEW.implemented_at IS DISTINCT FROM OLD.implemented_at OR NEW.implemented_by IS DISTINCT FROM OLD.implemented_by) THEN
    RAISE EXCEPTION 'The implementation record cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gie_recommendations_guard BEFORE UPDATE ON __SCHEMA__.gie_recommendations
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.guard_recommendation();

ALTER TABLE __SCHEMA__.gie_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read recommendations" ON __SCHEMA__.gie_recommendations
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
GRANT SELECT ON __SCHEMA__.gie_recommendations TO authenticated;
GRANT ALL ON __SCHEMA__.gie_recommendations TO service_role;
-- Suggestions and what people decided about them are a record: never removed.
REVOKE DELETE, TRUNCATE ON __SCHEMA__.gie_recommendations FROM service_role;

NOTIFY pgrst, 'reload schema';
