-- Growth Intelligence Engine: broken-link check results are stored as a source row. Needs the Phase 2 migration.
ALTER TABLE __SCHEMA__.gie_sources DROP CONSTRAINT gie_sources_source_type_check;
ALTER TABLE __SCHEMA__.gie_sources ADD CONSTRAINT gie_sources_source_type_check CHECK (source_type IN ('web_page', 'pagespeed', 'link_check'));

NOTIFY pgrst, 'reload schema';
