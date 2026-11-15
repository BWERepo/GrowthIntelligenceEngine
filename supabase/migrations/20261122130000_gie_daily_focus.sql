-- Growth Intelligence Engine: what the day's plan leans towards. Needs the Phase 1 migration.
ALTER TABLE __SCHEMA__.gie_tenant_work_schedules
  ADD COLUMN daily_focus text NOT NULL DEFAULT 'balanced' CHECK (daily_focus IN ('balanced', 'quick_wins', 'new_business', 'short_day'));

NOTIFY pgrst, 'reload schema';
