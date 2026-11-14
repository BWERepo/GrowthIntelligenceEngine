-- Growth Intelligence Engine: Phase 4, End-of-Day Review. Needs the Phase 3 migrations.
--
-- One review per workspace per local date, built by the server at the evening
-- time from the day's action package. A person corrects what was missed and
-- chooses what happens to each unfinished item, then finalizes; a finalized
-- review is locked. The AI assessment is written once, by the server, from
-- recorded facts only.

-- Dispositions that hold or lower an opportunity are recorded on it, server-only.
ALTER TABLE __SCHEMA__.gie_opportunities
  ADD COLUMN hold_until date,
  ADD COLUMN hold_reason text CHECK (hold_reason IN ('rescheduled', 'blocked')),
  ADD COLUMN priority_multiplier numeric(3, 2) NOT NULL DEFAULT 1 CHECK (priority_multiplier BETWEEN 0.1 AND 1),
  ADD CONSTRAINT gie_opportunities_hold_pair CHECK ((hold_until IS NULL) = (hold_reason IS NULL));

-- Review events join the action-event log.
ALTER TABLE __SCHEMA__.gie_daily_action_events DROP CONSTRAINT gie_daily_action_events_event_type_check;
ALTER TABLE __SCHEMA__.gie_daily_action_events ADD CONSTRAINT gie_daily_action_events_event_type_check CHECK (event_type IN
  ('created', 'status_changed', 'draft_created', 'draft_edited', 'draft_approved', 'draft_discarded',
   'contacted', 'follow_up_set', 'follow_up_completed', 'note', 'review_corrected', 'disposition_applied'));

CREATE TABLE __SCHEMA__.gie_end_of_day_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  package_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized')),
  late boolean NOT NULL DEFAULT false,
  built_at timestamptz NOT NULL DEFAULT now(),
  finalized_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  finalized_at timestamptz,
  -- A short provisional list for the next business day. The morning package rebuilds it from fresh data.
  tomorrow_plan jsonb,
  tomorrow_date date,
  -- Set by the server while it applies the decisions, so a double click cannot apply them twice.
  finalizing_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, local_date),
  FOREIGN KEY (tenant_id, package_id) REFERENCES __SCHEMA__.gie_daily_action_packages (tenant_id, id),
  CHECK (status <> 'finalized' OR (finalized_by IS NOT NULL AND finalized_at IS NOT NULL))
);

CREATE TABLE __SCHEMA__.gie_end_of_day_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  review_id uuid NOT NULL,
  item_id uuid NOT NULL,
  -- What the record said when the review was built, and what the person says it should be.
  recorded_status text NOT NULL CHECK (recorded_status IN ('not_started', 'in_progress', 'completed', 'deferred', 'blocked', 'awaiting_response', 'cancelled')),
  corrected_status text CHECK (corrected_status IN ('not_started', 'in_progress', 'completed', 'deferred', 'blocked', 'awaiting_response', 'cancelled')),
  -- Earlier packages in which this item appeared and was not finished (today's is not counted).
  times_unfinished smallint NOT NULL DEFAULT 0 CHECK (times_unfinished >= 0),
  stale boolean NOT NULL DEFAULT false,
  recommended_disposition text NOT NULL CHECK (recommended_disposition IN ('none', 'carry_forward', 'reschedule', 'lower_priority', 'block', 'archive', 'dismiss')),
  disposition text CHECK (disposition IN ('none', 'carry_forward', 'reschedule', 'lower_priority', 'block', 'archive', 'dismiss')),
  disposition_date date,
  note text CHECK (char_length(note) <= 300),
  -- When the server carried out the decision (once).
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- An item is reviewed once per review.
  UNIQUE (tenant_id, review_id, item_id),
  FOREIGN KEY (tenant_id, review_id) REFERENCES __SCHEMA__.gie_end_of_day_reviews (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES __SCHEMA__.gie_daily_action_items (tenant_id, id),
  CHECK (disposition NOT IN ('reschedule', 'block') OR disposition_date IS NOT NULL)
);

CREATE TABLE __SCHEMA__.gie_ai_daily_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  review_id uuid NOT NULL,
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  went_well text[] NOT NULL DEFAULT '{}',
  needs_attention text[] NOT NULL DEFAULT '{}',
  suggestion text CHECK (char_length(suggestion) <= 500),
  model text NOT NULL CHECK (char_length(model) <= 80),
  prompt_version text NOT NULL CHECK (char_length(prompt_version) <= 40),
  -- Hash of the facts given to the model, so the assessment can be tied to its inputs.
  inputs_hash text NOT NULL CHECK (char_length(inputs_hash) <= 80),
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Written once per review.
  UNIQUE (tenant_id, review_id),
  FOREIGN KEY (tenant_id, review_id) REFERENCES __SCHEMA__.gie_end_of_day_reviews (tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER gie_end_of_day_review_items_touch BEFORE UPDATE ON __SCHEMA__.gie_end_of_day_review_items
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();

-- A finalized review, its items and its assessment never change.
CREATE FUNCTION __SCHEMA__.lock_finalized_review()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'gie_end_of_day_reviews' THEN
    IF OLD.status = 'finalized' THEN
      RAISE EXCEPTION 'A finalized review cannot be changed' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM __SCHEMA__.gie_end_of_day_reviews r WHERE r.tenant_id = OLD.tenant_id AND r.id = OLD.review_id AND r.status = 'finalized') THEN
      RAISE EXCEPTION 'A finalized review cannot be changed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gie_end_of_day_reviews_lock BEFORE UPDATE ON __SCHEMA__.gie_end_of_day_reviews
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.lock_finalized_review();
CREATE TRIGGER gie_end_of_day_review_items_lock BEFORE UPDATE ON __SCHEMA__.gie_end_of_day_review_items
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.lock_finalized_review();
CREATE TRIGGER gie_ai_daily_assessments_immutable BEFORE UPDATE ON __SCHEMA__.gie_ai_daily_assessments
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.forbid_change();

ALTER TABLE __SCHEMA__.gie_end_of_day_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_end_of_day_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_ai_daily_assessments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read reviews" ON __SCHEMA__.gie_end_of_day_reviews
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Members read review items" ON __SCHEMA__.gie_end_of_day_review_items
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Operators correct review items" ON __SCHEMA__.gie_end_of_day_review_items
  FOR UPDATE TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));
CREATE POLICY "Members read assessments" ON __SCHEMA__.gie_ai_daily_assessments
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));

GRANT SELECT ON __SCHEMA__.gie_end_of_day_reviews, __SCHEMA__.gie_end_of_day_review_items, __SCHEMA__.gie_ai_daily_assessments TO authenticated;
-- People correct the status and choose the disposition; building, finalizing and applying are server acts.
GRANT UPDATE (corrected_status, disposition, disposition_date, note) ON __SCHEMA__.gie_end_of_day_review_items TO authenticated;
GRANT ALL ON __SCHEMA__.gie_end_of_day_reviews, __SCHEMA__.gie_end_of_day_review_items, __SCHEMA__.gie_ai_daily_assessments TO service_role;

NOTIFY pgrst, 'reload schema';
