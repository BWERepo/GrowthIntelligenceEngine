-- Growth Intelligence Engine: sign-in with the BWE back-office PIN. Needs the Phase 1 migration.
--
-- These two tables belong to a person's sign-in, not to a workspace, so (unlike every other GIE
-- table) they have no tenant_id. They have RLS on and NO policy: the browser can read and write
-- nothing; only the server (service role) uses them. The PIN itself is never stored here; its
-- keyed hash is read, read-only, from BWE's admin_quick_codes.

-- Wrong-PIN counter and lock, kept here because BWE's own table must not be written from GIE.
CREATE TABLE __SCHEMA__.gie_pin_attempts (
  user_id uuid PRIMARY KEY,
  failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 100),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A sign-in session (the "session_id" claim of its token) that has passed the PIN check.
CREATE TABLE __SCHEMA__.gie_pin_sessions (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gie_pin_sessions_user_idx ON __SCHEMA__.gie_pin_sessions (user_id, verified_at DESC);

ALTER TABLE __SCHEMA__.gie_pin_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE __SCHEMA__.gie_pin_sessions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON __SCHEMA__.gie_pin_attempts, __SCHEMA__.gie_pin_sessions TO service_role;
REVOKE TRUNCATE ON __SCHEMA__.gie_pin_attempts, __SCHEMA__.gie_pin_sessions FROM service_role;

NOTIFY pgrst, 'reload schema';
