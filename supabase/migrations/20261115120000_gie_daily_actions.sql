-- Growth Intelligence Engine: Phase 3, Daily Action Center (first slice).
--
-- Template rendered like the earlier migrations. Needs the foundation and
-- discovery migrations first.
--
-- Covers: prospects, outreach drafts (a person approves; nothing here sends),
-- follow-up tasks, one action package per tenant-local date with at most five
-- ranked items, and the append-only action event log. Sending approved email
-- and reply detection come in the next slice.
--
-- Isolation is as before: tenant_id on every row, RLS through has_tenant_role(),
-- composite (tenant_id, id) foreign keys. Server-only writes have no grant for
-- signed-in users.

-- ---------------------------------------------------------------- prospects
CREATE TABLE __SCHEMA__.gie_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  opportunity_id uuid,
  business_name text NOT NULL CHECK (char_length(business_name) BETWEEN 1 AND 200),
  website_url text CHECK (char_length(website_url) <= 2048),
  contact_email text CHECK (contact_email ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' AND char_length(contact_email) <= 254),
  contact_channel text NOT NULL DEFAULT 'none' CHECK (contact_channel IN ('email', 'form', 'phone', 'none')),
  -- Links to BWE's own records (ids only; BWE stays the source of truth).
  bwe_lead_id uuid,
  bwe_lead_prospect_id uuid,
  do_not_contact boolean NOT NULL DEFAULT false,
  do_not_contact_reason text CHECK (char_length(do_not_contact_reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- A business is one prospect per workspace.
  UNIQUE (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES __SCHEMA__.gie_opportunities (tenant_id, id)
);
CREATE INDEX gie_prospects_tenant_idx ON __SCHEMA__.gie_prospects (tenant_id, created_at DESC);

-- ---------------------------------------------------------------- outreach drafts
CREATE TABLE __SCHEMA__.gie_outreach_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 6000),
  follow_up_body text CHECK (char_length(follow_up_body) <= 4000),
  -- Validator findings. 'errors' block approval; 'warnings' are shown to the person.
  validation jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'discarded')),
  model text CHECK (char_length(model) <= 80),
  prompt_version text CHECK (char_length(prompt_version) <= 40),
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  edited_by_person boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, prospect_id) REFERENCES __SCHEMA__.gie_prospects (tenant_id, id) ON DELETE CASCADE,
  -- Approval is a person's act: it needs who and when.
  CHECK (status NOT IN ('approved', 'sent') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX gie_outreach_drafts_prospect_idx ON __SCHEMA__.gie_outreach_drafts (tenant_id, prospect_id, created_at DESC);
-- One live draft per prospect: a new one replaces the old.
CREATE UNIQUE INDEX gie_outreach_drafts_one_open_idx ON __SCHEMA__.gie_outreach_drafts (tenant_id, prospect_id)
  WHERE status IN ('draft', 'approved');

-- ---------------------------------------------------------------- follow-ups
CREATE TABLE __SCHEMA__.gie_follow_up_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL,
  due_date date NOT NULL,
  note text CHECK (char_length(note) <= 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  completed_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, prospect_id) REFERENCES __SCHEMA__.gie_prospects (tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX gie_follow_up_tasks_due_idx ON __SCHEMA__.gie_follow_up_tasks (tenant_id, status, due_date);

-- ---------------------------------------------------------------- daily packages
CREATE TABLE __SCHEMA__.gie_daily_action_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  late boolean NOT NULL DEFAULT false,
  ranking_version text NOT NULL CHECK (char_length(ranking_version) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- One package per workspace per local date, however often the job runs.
  UNIQUE (tenant_id, local_date)
);

CREATE TABLE __SCHEMA__.gie_daily_action_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  package_id uuid NOT NULL,
  rank smallint NOT NULL CHECK (rank BETWEEN 1 AND 5),
  kind text NOT NULL CHECK (kind IN ('follow_up', 'opportunity')),
  opportunity_id uuid,
  follow_up_id uuid,
  prospect_id uuid,
  recommended_action text NOT NULL CHECK (char_length(recommended_action) BETWEEN 1 AND 300),
  effort text NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
  importance smallint NOT NULL CHECK (importance BETWEEN 1 AND 10),
  rank_score numeric(8, 3) NOT NULL,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'deferred', 'blocked', 'awaiting_response', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, package_id, rank),
  FOREIGN KEY (tenant_id, package_id) REFERENCES __SCHEMA__.gie_daily_action_packages (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES __SCHEMA__.gie_opportunities (tenant_id, id),
  FOREIGN KEY (tenant_id, follow_up_id) REFERENCES __SCHEMA__.gie_follow_up_tasks (tenant_id, id),
  FOREIGN KEY (tenant_id, prospect_id) REFERENCES __SCHEMA__.gie_prospects (tenant_id, id),
  CHECK ((kind = 'follow_up' AND follow_up_id IS NOT NULL) OR (kind = 'opportunity' AND opportunity_id IS NOT NULL))
);
-- The same opportunity or follow-up appears once per package.
CREATE UNIQUE INDEX gie_daily_action_items_opp_idx ON __SCHEMA__.gie_daily_action_items (tenant_id, package_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE UNIQUE INDEX gie_daily_action_items_fu_idx ON __SCHEMA__.gie_daily_action_items (tenant_id, package_id, follow_up_id) WHERE follow_up_id IS NOT NULL;

-- Append-only record of everything done to an action item.
CREATE TABLE __SCHEMA__.gie_daily_action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN
    ('created', 'status_changed', 'draft_created', 'draft_edited', 'draft_approved', 'draft_discarded',
     'contacted', 'follow_up_set', 'follow_up_completed', 'note')),
  from_status text,
  to_status text,
  detail jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, item_id) REFERENCES __SCHEMA__.gie_daily_action_items (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX gie_daily_action_events_item_idx ON __SCHEMA__.gie_daily_action_events (tenant_id, item_id, occurred_at);

-- ---------------------------------------------------------------- triggers
CREATE TRIGGER gie_prospects_touch BEFORE UPDATE ON __SCHEMA__.gie_prospects
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();
CREATE TRIGGER gie_outreach_drafts_touch BEFORE UPDATE ON __SCHEMA__.gie_outreach_drafts
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();
CREATE TRIGGER gie_follow_up_tasks_touch BEFORE UPDATE ON __SCHEMA__.gie_follow_up_tasks
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();
CREATE TRIGGER gie_daily_action_items_touch BEFORE UPDATE ON __SCHEMA__.gie_daily_action_items
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();
CREATE TRIGGER gie_daily_action_events_immutable BEFORE UPDATE ON __SCHEMA__.gie_daily_action_events
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.forbid_change();

-- Outreach to someone marked do-not-contact can never be approved or sent.
CREATE FUNCTION __SCHEMA__.block_draft_for_do_not_contact()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IN ('approved', 'sent') AND EXISTS (
    SELECT 1 FROM __SCHEMA__.gie_prospects p
    WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.prospect_id AND p.do_not_contact
  ) THEN
    RAISE EXCEPTION 'This prospect is marked do-not-contact' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gie_outreach_drafts_dnc BEFORE INSERT OR UPDATE ON __SCHEMA__.gie_outreach_drafts
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.block_draft_for_do_not_contact();

-- ---------------------------------------------------------------- row level security
ALTER TABLE __SCHEMA__.gie_prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_outreach_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_follow_up_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_daily_action_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_daily_action_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_daily_action_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read prospects" ON __SCHEMA__.gie_prospects
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Operators update prospects" ON __SCHEMA__.gie_prospects
  FOR UPDATE TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));

CREATE POLICY "Operators read drafts" ON __SCHEMA__.gie_outreach_drafts
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));
-- Operators edit the wording (column grant below). Approving, discarding and
-- sending are server functions: they re-run the validator first.
CREATE POLICY "Operators update drafts" ON __SCHEMA__.gie_outreach_drafts
  FOR UPDATE TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));

CREATE POLICY "Members read follow-ups" ON __SCHEMA__.gie_follow_up_tasks
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Operators manage follow-ups" ON __SCHEMA__.gie_follow_up_tasks
  FOR ALL TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));

CREATE POLICY "Members read packages" ON __SCHEMA__.gie_daily_action_packages
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Members read action items" ON __SCHEMA__.gie_daily_action_items
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Operators update action items" ON __SCHEMA__.gie_daily_action_items
  FOR UPDATE TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));
CREATE POLICY "Members read action events" ON __SCHEMA__.gie_daily_action_events
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Operators add action events" ON __SCHEMA__.gie_daily_action_events
  FOR INSERT TO authenticated WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));

-- ---------------------------------------------------------------- grants
GRANT SELECT ON
  __SCHEMA__.gie_prospects, __SCHEMA__.gie_outreach_drafts, __SCHEMA__.gie_follow_up_tasks,
  __SCHEMA__.gie_daily_action_packages, __SCHEMA__.gie_daily_action_items, __SCHEMA__.gie_daily_action_events
  TO authenticated;
-- People change only these columns; everything else is written by the server.
GRANT UPDATE (do_not_contact, do_not_contact_reason) ON __SCHEMA__.gie_prospects TO authenticated;
GRANT UPDATE (subject, body, follow_up_body, edited_by_person) ON __SCHEMA__.gie_outreach_drafts TO authenticated;
GRANT INSERT, UPDATE ON __SCHEMA__.gie_follow_up_tasks TO authenticated;
GRANT UPDATE (status) ON __SCHEMA__.gie_daily_action_items TO authenticated;
GRANT INSERT ON __SCHEMA__.gie_daily_action_events TO authenticated;
GRANT ALL ON
  __SCHEMA__.gie_prospects, __SCHEMA__.gie_outreach_drafts, __SCHEMA__.gie_follow_up_tasks,
  __SCHEMA__.gie_daily_action_packages, __SCHEMA__.gie_daily_action_items, __SCHEMA__.gie_daily_action_events
  TO service_role;
-- The event log is permanent.
REVOKE UPDATE, DELETE, TRUNCATE ON __SCHEMA__.gie_daily_action_events FROM service_role;

NOTIFY pgrst, 'reload schema';
