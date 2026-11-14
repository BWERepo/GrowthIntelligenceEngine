-- Growth Intelligence Engine: Phase 2, discovery and scoring.
--
-- Template, rendered like the foundation migration (__SCHEMA__ = gie_staging or
-- gie_prod). Needs 20261113150000_gie_foundation.sql first.
--
-- Flow: campaign queries -> search results become gie_discovery_candidates
-- (a work queue) -> each candidate's page is fetched (gie_sources), classified
-- by AI (gie_opportunity_classifications, immutable) and scored in code
-- (gie_opportunity_scores + components, immutable) -> gie_opportunities.
--
-- Isolation: every table carries tenant_id with RLS through has_tenant_role().
-- References between GIE rows use composite (tenant_id, id) foreign keys, so a
-- row can never point at another tenant's row. Only the server (service role)
-- writes sources, candidates, classifications and scores; people manage
-- campaigns (operators and owners) and change an opportunity's status.

-- ---------------------------------------------------------------- campaigns
CREATE TABLE __SCHEMA__.gie_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  -- Industries and places this campaign looks for; used for the "fit" part of the score.
  industries text[] NOT NULL DEFAULT '{}' CHECK (cardinality(industries) <= 40),
  locations text[] NOT NULL DEFAULT '{}' CHECK (cardinality(locations) <= 40),
  -- Search queries, kept apart by signal type so the two are never mixed up.
  -- "{location}" in a query is replaced by each location in turn.
  buying_intent_queries text[] NOT NULL DEFAULT '{}' CHECK (cardinality(buying_intent_queries) <= 40),
  prospecting_queries text[] NOT NULL DEFAULT '{}' CHECK (cardinality(prospecting_queries) <= 40),
  max_age_days smallint NOT NULL DEFAULT 60 CHECK (max_age_days BETWEEN 1 AND 365),
  daily_search_limit smallint NOT NULL DEFAULT 20 CHECK (daily_search_limit BETWEEN 1 AND 200),
  daily_candidate_limit smallint NOT NULL DEFAULT 40 CHECK (daily_candidate_limit BETWEEN 1 AND 200),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX gie_campaigns_tenant_status_idx ON __SCHEMA__.gie_campaigns (tenant_id, status);

-- ---------------------------------------------------------------- sources (fetched pages, PageSpeed results)
CREATE TABLE __SCHEMA__.gie_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('web_page', 'pagespeed')),
  normalized_url text NOT NULL CHECK (char_length(normalized_url) BETWEEN 8 AND 2048),
  host text NOT NULL CHECK (char_length(host) BETWEEN 1 AND 253),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  http_status smallint,
  robots_allowed boolean NOT NULL,
  content_hash text CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  -- Plain text of the page as fetched (capped), kept so every evidence quote
  -- can be checked again later. PageSpeed rows keep their numbers in metrics.
  content_text text CHECK (char_length(content_text) <= 60000),
  content_truncated boolean NOT NULL DEFAULT false,
  -- Contact channels found in the page's own markup (mailto:, tel:, forms).
  contact jsonb,
  metrics jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source_type, normalized_url, fetched_at)
);
CREATE INDEX gie_sources_tenant_url_idx ON __SCHEMA__.gie_sources (tenant_id, normalized_url, fetched_at DESC);

-- ---------------------------------------------------------------- opportunities
CREATE TABLE __SCHEMA__.gie_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  source_id uuid NOT NULL,
  signal_type text NOT NULL CHECK (signal_type IN ('buying_intent', 'prospecting')),
  business_name text NOT NULL CHECK (char_length(business_name) BETWEEN 1 AND 200),
  -- The business's own website, only when it was verified (the page is on that
  -- site, or links to it). Never guessed.
  website_url text CHECK (char_length(website_url) <= 2048),
  source_url text NOT NULL CHECK (char_length(source_url) BETWEEN 8 AND 2048),
  industry text CHECK (char_length(industry) <= 80),
  location text CHECK (char_length(location) <= 120),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'saved', 'pursuing', 'dismissed', 'converted', 'archived')),
  dismiss_reason text CHECK (char_length(dismiss_reason) <= 300),
  -- Website host, or the source URL when no website was verified: one opportunity per business per tenant.
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 2048),
  -- Copy of the newest score row, for sorting; the score history stays in gie_opportunity_scores.
  latest_score smallint CHECK (latest_score BETWEEN 0 AND 100),
  latest_band text CHECK (latest_band IN ('very_high', 'high', 'review', 'low')),
  status_changed_at timestamptz,
  status_changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, dedupe_key),
  CHECK (status <> 'dismissed' OR dismiss_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES __SCHEMA__.gie_campaigns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_id) REFERENCES __SCHEMA__.gie_sources (tenant_id, id)
);
CREATE INDEX gie_opportunities_tenant_rank_idx ON __SCHEMA__.gie_opportunities (tenant_id, status, latest_score DESC NULLS LAST);

-- ---------------------------------------------------------------- discovery queue
CREATE TABLE __SCHEMA__.gie_discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  signal_type text NOT NULL CHECK (signal_type IN ('buying_intent', 'prospecting')),
  query text NOT NULL CHECK (char_length(query) BETWEEN 1 AND 400),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 60),
  url text NOT NULL CHECK (char_length(url) BETWEEN 8 AND 2048),
  normalized_url text NOT NULL CHECK (char_length(normalized_url) BETWEEN 8 AND 2048),
  title text CHECK (char_length(title) <= 500),
  snippet text CHECK (char_length(snippet) <= 2000),
  -- When the search provider says the page was published, if it says so.
  published_at timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending', 'processing', 'classified', 'rejected', 'duplicate', 'blocked', 'failed')),
  reason text CHECK (char_length(reason) <= 500),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  claimed_at timestamptz,
  opportunity_id uuid,
  local_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- The same page is queued once per tenant, however many queries find it.
  UNIQUE (tenant_id, normalized_url),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES __SCHEMA__.gie_campaigns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES __SCHEMA__.gie_opportunities (tenant_id, id)
);
CREATE INDEX gie_discovery_candidates_queue_idx ON __SCHEMA__.gie_discovery_candidates (tenant_id, state, created_at);

-- ---------------------------------------------------------------- classifications (immutable)
CREATE TABLE __SCHEMA__.gie_opportunity_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL,
  -- Set when the classification was accepted and produced or updated an opportunity.
  opportunity_id uuid,
  source_id uuid NOT NULL,
  schema_version text NOT NULL CHECK (char_length(schema_version) BETWEEN 1 AND 40),
  prompt_version text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 40),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 80),
  -- 'accepted', or why the output was thrown away. Rejected output is never repaired.
  outcome text NOT NULL CHECK (outcome IN
    ('accepted', 'schema_invalid', 'evidence_not_found', 'not_a_business', 'refused', 'error')),
  output jsonb,
  evidence_checked jsonb,
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES __SCHEMA__.gie_discovery_candidates (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES __SCHEMA__.gie_opportunities (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_id) REFERENCES __SCHEMA__.gie_sources (tenant_id, id)
);
CREATE INDEX gie_opportunity_classifications_opp_idx ON __SCHEMA__.gie_opportunity_classifications (tenant_id, opportunity_id, created_at DESC);

-- ---------------------------------------------------------------- scores (immutable; a new row on every recalculation)
CREATE TABLE __SCHEMA__.gie_opportunity_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL,
  classification_id uuid NOT NULL,
  rule_version text NOT NULL CHECK (char_length(rule_version) BETWEEN 1 AND 40),
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  band text NOT NULL CHECK (band IN ('very_high', 'high', 'review', 'low')),
  -- Everything the rules read, so the score can be recomputed exactly.
  inputs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES __SCHEMA__.gie_opportunities (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, classification_id) REFERENCES __SCHEMA__.gie_opportunity_classifications (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX gie_opportunity_scores_opp_idx ON __SCHEMA__.gie_opportunity_scores (tenant_id, opportunity_id, created_at DESC);

CREATE TABLE __SCHEMA__.gie_opportunity_score_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  score_id uuid NOT NULL,
  component text NOT NULL CHECK (component IN ('intent', 'fit', 'freshness', 'reachability', 'evidence')),
  weight smallint NOT NULL CHECK (weight BETWEEN 0 AND 100),
  value numeric(5, 4) NOT NULL CHECK (value BETWEEN 0 AND 1),
  points numeric(6, 2) NOT NULL CHECK (points >= 0 AND points <= weight),
  explanation text NOT NULL CHECK (char_length(explanation) BETWEEN 1 AND 500),
  UNIQUE (tenant_id, score_id, component),
  FOREIGN KEY (tenant_id, score_id) REFERENCES __SCHEMA__.gie_opportunity_scores (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- triggers
CREATE TRIGGER gie_campaigns_touch BEFORE UPDATE ON __SCHEMA__.gie_campaigns
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();
CREATE TRIGGER gie_opportunities_touch BEFORE UPDATE ON __SCHEMA__.gie_opportunities
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();
CREATE TRIGGER gie_discovery_candidates_touch BEFORE UPDATE ON __SCHEMA__.gie_discovery_candidates
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.touch_updated_at();

-- Classifications and scores are a permanent record: once written they never
-- change, except that a classification is linked to its opportunity once.
CREATE FUNCTION __SCHEMA__.forbid_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be changed', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

CREATE FUNCTION __SCHEMA__.classification_link_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.opportunity_id IS NULL AND NEW.opportunity_id IS NOT NULL
     AND (to_jsonb(NEW) - 'opportunity_id') = (to_jsonb(OLD) - 'opportunity_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'gie_opportunity_classifications rows cannot be changed' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER gie_opportunity_classifications_immutable BEFORE UPDATE ON __SCHEMA__.gie_opportunity_classifications
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.classification_link_only();
CREATE TRIGGER gie_opportunity_scores_immutable BEFORE UPDATE ON __SCHEMA__.gie_opportunity_scores
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.forbid_change();
CREATE TRIGGER gie_opportunity_score_components_immutable BEFORE UPDATE ON __SCHEMA__.gie_opportunity_score_components
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.forbid_change();

-- ---------------------------------------------------------------- queue claim (server only)
-- Hands out up to _limit pending candidates of one tenant and marks them
-- 'processing'. SKIP LOCKED means two overlapping runs never take the same row.
-- A candidate stuck in 'processing' for 30 minutes (a crashed run) is handed
-- out again, up to 3 attempts.
CREATE FUNCTION __SCHEMA__.claim_discovery_candidates(_tenant_id uuid, _limit int)
RETURNS SETOF __SCHEMA__.gie_discovery_candidates
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE __SCHEMA__.gie_discovery_candidates c
  SET state = 'processing', claimed_at = now(), attempts = c.attempts + 1
  WHERE c.id IN (
    SELECT id FROM __SCHEMA__.gie_discovery_candidates
    WHERE tenant_id = _tenant_id
      AND attempts < 3
      AND (state = 'pending' OR (state = 'processing' AND claimed_at < now() - interval '30 minutes'))
    ORDER BY created_at
    LIMIT greatest(0, least(_limit, 25))
    FOR UPDATE SKIP LOCKED
  )
  RETURNING c.*
$$;
REVOKE ALL ON FUNCTION __SCHEMA__.claim_discovery_candidates(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SCHEMA__.claim_discovery_candidates(uuid, int) TO service_role;

-- ---------------------------------------------------------------- row level security
ALTER TABLE __SCHEMA__.gie_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_discovery_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_opportunity_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_opportunity_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_opportunity_score_components ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read campaigns" ON __SCHEMA__.gie_campaigns
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Operators create campaigns" ON __SCHEMA__.gie_campaigns
  FOR INSERT TO authenticated WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));
CREATE POLICY "Operators update campaigns" ON __SCHEMA__.gie_campaigns
  FOR UPDATE TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));

CREATE POLICY "Members read sources" ON __SCHEMA__.gie_sources
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));

CREATE POLICY "Members read opportunities" ON __SCHEMA__.gie_opportunities
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
-- Operators change status only (column grant below); everything else is server-written.
CREATE POLICY "Operators update opportunity status" ON __SCHEMA__.gie_opportunities
  FOR UPDATE TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));

CREATE POLICY "Operators read discovery queue" ON __SCHEMA__.gie_discovery_candidates
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));

CREATE POLICY "Members read classifications" ON __SCHEMA__.gie_opportunity_classifications
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Members read scores" ON __SCHEMA__.gie_opportunity_scores
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Members read score components" ON __SCHEMA__.gie_opportunity_score_components
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));

-- ---------------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE ON __SCHEMA__.gie_campaigns TO authenticated;
GRANT SELECT ON
  __SCHEMA__.gie_sources,
  __SCHEMA__.gie_opportunities,
  __SCHEMA__.gie_discovery_candidates,
  __SCHEMA__.gie_opportunity_classifications,
  __SCHEMA__.gie_opportunity_scores,
  __SCHEMA__.gie_opportunity_score_components
  TO authenticated;
GRANT UPDATE (status, dismiss_reason, status_changed_at, status_changed_by) ON __SCHEMA__.gie_opportunities TO authenticated;
GRANT ALL ON
  __SCHEMA__.gie_campaigns,
  __SCHEMA__.gie_sources,
  __SCHEMA__.gie_opportunities,
  __SCHEMA__.gie_discovery_candidates,
  __SCHEMA__.gie_opportunity_classifications,
  __SCHEMA__.gie_opportunity_scores,
  __SCHEMA__.gie_opportunity_score_components
  TO service_role;
-- Permanent records: no deletes, even by the server (tenant deletion still cascades).
REVOKE DELETE, TRUNCATE ON
  __SCHEMA__.gie_opportunity_classifications,
  __SCHEMA__.gie_opportunity_scores,
  __SCHEMA__.gie_opportunity_score_components
  FROM service_role;

-- ---------------------------------------------------------------- seed: a draft campaign for BWE
-- Starts as a draft: nothing is searched until an operator reviews the queries
-- and sets it to active. Industries are the ones named in the owner's decision
-- BWE SEO engine's industry guides (auto repair, retail); edit on the Campaigns page.
INSERT INTO __SCHEMA__.gie_campaigns
  (tenant_id, name, status, industries, locations, buying_intent_queries, prospecting_queries, daily_candidate_limit)
SELECT id, 'East Tennessee small businesses', 'draft',
  '{HVAC,Dental,Restaurants,"Home services",Legal,Nonprofits,"Auto repair",Retail}',
  '{"Knoxville, TN","Chattanooga, TN","Maryville, TN","Oak Ridge, TN","Sevierville, TN"}',
  '{"\"looking for a web designer\" {location}","\"need a new website\" {location}","\"website redesign\" RFP {location}"}',
  '{"HVAC company {location}","dentist {location}","family law attorney {location}"}',
  -- 25 new pages a business day keeps Opus 5.5 classification (about $0.07 a page) under the $50 cap.
  25
FROM __SCHEMA__.gie_tenants WHERE slug = 'bwe';

NOTIFY pgrst, 'reload schema';
