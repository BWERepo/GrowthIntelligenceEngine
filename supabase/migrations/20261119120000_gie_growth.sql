-- Growth Intelligence Engine: Phase 6, 30-Day Growth Performance. Needs the Phase 5 migration.
--
-- Outcomes are recorded once, each keyed by the row in its source table, so a
-- repeated sync never counts anything twice. Attribution is stored with its
-- basis and confidence; an event with no recorded link is 'unknown', never guessed.
-- A frozen 30-day report is stored once per day and never rewritten.

CREATE FUNCTION __SCHEMA__.guard_growth_event()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- Only the attribution of an event may be refreshed (a link can appear later).
  -- What happened, when, and from which row never changes.
  IF to_jsonb(NEW) - 'prospect_id' - 'attribution' - 'attribution_confidence' - 'attribution_basis'
     IS DISTINCT FROM to_jsonb(OLD) - 'prospect_id' - 'attribution' - 'attribution_confidence' - 'attribution_basis' THEN
    RAISE EXCEPTION 'A recorded outcome cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE __SCHEMA__.gie_sales_funnel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('opportunity', 'pursued', 'contacted', 'replied', 'lead', 'meeting', 'proposal', 'agreement', 'deposit', 'customer')),
  occurred_at timestamptz NOT NULL,
  -- The row the event was read from: one row yields one event per stage.
  source_table text NOT NULL CHECK (char_length(source_table) BETWEEN 1 AND 60),
  source_id uuid NOT NULL,
  prospect_id uuid,
  attribution text NOT NULL DEFAULT 'unknown' CHECK (attribution IN ('first_touch', 'last_touch', 'assisted', 'unknown')),
  attribution_confidence text NOT NULL DEFAULT 'none' CHECK (attribution_confidence IN ('high', 'medium', 'low', 'none')),
  attribution_basis text CHECK (char_length(attribution_basis) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, stage, source_table, source_id),
  FOREIGN KEY (tenant_id, prospect_id) REFERENCES __SCHEMA__.gie_prospects (tenant_id, id) ON DELETE SET NULL (prospect_id),
  -- Unknown means no link, and a link always says how it was found.
  CHECK ((attribution = 'unknown') = (attribution_confidence = 'none')),
  CHECK (attribution = 'unknown' OR attribution_basis IS NOT NULL)
);
CREATE INDEX gie_sales_funnel_events_time_idx ON __SCHEMA__.gie_sales_funnel_events (tenant_id, stage, occurred_at DESC);
CREATE INDEX gie_sales_funnel_events_prospect_idx ON __SCHEMA__.gie_sales_funnel_events (tenant_id, prospect_id) WHERE prospect_id IS NOT NULL;

CREATE TABLE __SCHEMA__.gie_revenue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  -- BWE's payments.id: a payment is revenue once.
  payment_id uuid NOT NULL,
  paid_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (char_length(kind) <= 40),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  prospect_id uuid,
  attribution text NOT NULL DEFAULT 'unknown' CHECK (attribution IN ('first_touch', 'last_touch', 'assisted', 'unknown')),
  attribution_confidence text NOT NULL DEFAULT 'none' CHECK (attribution_confidence IN ('high', 'medium', 'low', 'none')),
  attribution_basis text CHECK (char_length(attribution_basis) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, payment_id),
  FOREIGN KEY (tenant_id, prospect_id) REFERENCES __SCHEMA__.gie_prospects (tenant_id, id) ON DELETE SET NULL (prospect_id),
  CHECK ((attribution = 'unknown') = (attribution_confidence = 'none')),
  CHECK (attribution = 'unknown' OR attribution_basis IS NOT NULL)
);
CREATE INDEX gie_revenue_events_time_idx ON __SCHEMA__.gie_revenue_events (tenant_id, paid_at DESC);

CREATE TRIGGER gie_sales_funnel_events_guard BEFORE UPDATE ON __SCHEMA__.gie_sales_funnel_events
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.guard_growth_event();
CREATE TRIGGER gie_revenue_events_guard BEFORE UPDATE ON __SCHEMA__.gie_revenue_events
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.guard_growth_event();

-- A 30-day report, frozen as it was shown on its date.
CREATE TABLE __SCHEMA__.gie_growth_period_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  -- Last day of the current period (yesterday, tenant-local, when it was taken).
  as_of_date date NOT NULL,
  window_days smallint NOT NULL CHECK (window_days BETWEEN 7 AND 90),
  min_events smallint NOT NULL CHECK (min_events BETWEEN 1 AND 1000),
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, as_of_date)
);
CREATE TRIGGER gie_growth_snapshots_immutable BEFORE UPDATE ON __SCHEMA__.gie_growth_period_snapshots
  FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.forbid_change();

ALTER TABLE __SCHEMA__.gie_sales_funnel_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_revenue_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_growth_period_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read funnel events" ON __SCHEMA__.gie_sales_funnel_events
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Members read revenue events" ON __SCHEMA__.gie_revenue_events
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
CREATE POLICY "Members read growth snapshots" ON __SCHEMA__.gie_growth_period_snapshots
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));

GRANT SELECT ON __SCHEMA__.gie_sales_funnel_events, __SCHEMA__.gie_revenue_events, __SCHEMA__.gie_growth_period_snapshots TO authenticated;
GRANT ALL ON __SCHEMA__.gie_sales_funnel_events, __SCHEMA__.gie_revenue_events, __SCHEMA__.gie_growth_period_snapshots TO service_role;
-- Outcomes and reports are written by the server, never removed; snapshots never altered either.
REVOKE DELETE, TRUNCATE ON __SCHEMA__.gie_sales_funnel_events, __SCHEMA__.gie_revenue_events FROM service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON __SCHEMA__.gie_growth_period_snapshots FROM service_role;

NOTIFY pgrst, 'reload schema';
