-- Minimal stand-in for the parts of Supabase the GIE migrations rely on, so
-- RLS can be tested on a plain local Postgres. Not used in production.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE auth.mfa_factors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, factor_type text, status text);

-- Supabase reads the caller from the request's JWT claims; tests set them with set_config.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

-- BWE's staging schema: just user_roles and has_role, as defined by BWE's
-- 2026-10-31 admin 2FA migration.
CREATE SCHEMA bwe_staging;
CREATE TYPE bwe_staging.app_role AS ENUM ('admin', 'customer');
CREATE TABLE bwe_staging.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  role bwe_staging.app_role NOT NULL,
  UNIQUE (user_id, role)
);
CREATE FUNCTION bwe_staging.has_role(_user_id uuid, _role bwe_staging.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = bwe_staging AS $$
  SELECT EXISTS (SELECT 1 FROM bwe_staging.user_roles WHERE user_id = _user_id AND role = _role)
  AND (
    _role::text <> 'admin'
    OR _user_id IS DISTINCT FROM auth.uid()
    OR coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    OR NOT EXISTS (SELECT 1 FROM auth.mfa_factors f
                   WHERE f.user_id = _user_id AND f.factor_type = 'totp' AND f.status = 'verified')
  )
$$;
GRANT USAGE ON SCHEMA bwe_staging TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION bwe_staging.has_role(uuid, bwe_staging.app_role) TO authenticated, service_role;

-- Test users. The admin exists before the GIE migration runs, so the seed makes them an owner.
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'admin@bwe.test'),
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@bwe.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'viewer-a@bwe.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@client.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'customer@client.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'hdbs-user@other.test');
INSERT INTO bwe_staging.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'admin'),
  ('00000000-0000-0000-0000-0000000000c1', 'customer');
-- The admin has an authenticator, so they count as admin only in a 2FA (aal2) session.
INSERT INTO auth.mfa_factors (user_id, factor_type, status)
VALUES ('00000000-0000-0000-0000-00000000000a', 'totp', 'verified');
