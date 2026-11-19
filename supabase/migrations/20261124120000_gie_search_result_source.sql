-- Growth Intelligence Engine: Facebook-only prospects keep the search result (title and snippet) they were found from
-- as their source, so every evidence quote can be checked again. Facebook pages themselves are never fetched.
-- Needs the link-check migration (20261122120000).
ALTER TABLE __SCHEMA__.gie_sources DROP CONSTRAINT gie_sources_source_type_check;
ALTER TABLE __SCHEMA__.gie_sources ADD CONSTRAINT gie_sources_source_type_check CHECK (source_type IN ('web_page', 'pagespeed', 'link_check', 'search_result'));

NOTIFY pgrst, 'reload schema';
