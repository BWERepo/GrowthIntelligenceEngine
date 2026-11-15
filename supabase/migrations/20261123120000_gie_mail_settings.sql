-- Growth Intelligence Engine: the visible sender of outreach (name, send-as address, reply-to).
-- The mailbox login and password are Worker secrets and are never stored here. Needs the Phase 1 migration.
CREATE TABLE __SCHEMA__.gie_tenant_mail_settings (
  tenant_id uuid PRIMARY KEY REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  from_name text NOT NULL DEFAULT 'Business Web Express' CHECK (char_length(from_name) BETWEEN 1 AND 80 AND from_name !~ '[\r\n<>"]'),
  from_email text CHECK (from_email IS NULL OR (char_length(from_email) <= 254 AND from_email ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$')),
  reply_to_email text CHECK (reply_to_email IS NULL OR (char_length(reply_to_email) <= 254 AND reply_to_email ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE __SCHEMA__.gie_tenant_mail_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read mail settings" ON __SCHEMA__.gie_tenant_mail_settings
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'viewer'));
GRANT SELECT ON __SCHEMA__.gie_tenant_mail_settings TO authenticated;
GRANT ALL ON __SCHEMA__.gie_tenant_mail_settings TO service_role;
REVOKE DELETE, TRUNCATE ON __SCHEMA__.gie_tenant_mail_settings FROM service_role;

NOTIFY pgrst, 'reload schema';
