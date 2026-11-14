-- Growth Intelligence Engine: Phase 3, second slice. Sending approved outreach
-- and reply detection. Needs the Phase 3 first-slice migration.
--
-- Sending is a server act on an approved draft; people never write the sent
-- columns. Replies are written only by the server's read-only mailbox sync.

ALTER TABLE __SCHEMA__.gie_outreach_drafts
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN sent_from text CHECK (char_length(sent_from) <= 254),
  ADD COLUMN sent_message_id text CHECK (char_length(sent_message_id) <= 300),
  ADD COLUMN send_error text CHECK (char_length(send_error) <= 500),
  ADD CONSTRAINT gie_outreach_drafts_sent_has_time CHECK (status <> 'sent' OR (sent_at IS NOT NULL AND sent_message_id IS NOT NULL));

CREATE TABLE __SCHEMA__.gie_outreach_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES __SCHEMA__.gie_tenants(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL,
  draft_id uuid,
  message_id text NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 300),
  in_reply_to text CHECK (char_length(in_reply_to) <= 600),
  from_email text NOT NULL CHECK (char_length(from_email) <= 254),
  subject text CHECK (char_length(subject) <= 300),
  -- First part of the text only, for the person to decide whether to open it.
  snippet text CHECK (char_length(snippet) <= 600),
  kind text NOT NULL CHECK (kind IN ('reply', 'auto_reply', 'bounce')),
  received_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, message_id),
  FOREIGN KEY (tenant_id, prospect_id) REFERENCES __SCHEMA__.gie_prospects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, draft_id) REFERENCES __SCHEMA__.gie_outreach_drafts (tenant_id, id) ON DELETE SET NULL (draft_id)
);
CREATE INDEX gie_outreach_replies_tenant_idx ON __SCHEMA__.gie_outreach_replies (tenant_id, status, received_at DESC);

ALTER TABLE __SCHEMA__.gie_outreach_replies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Operators read replies" ON __SCHEMA__.gie_outreach_replies
  FOR SELECT TO authenticated USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));
CREATE POLICY "Operators mark replies handled" ON __SCHEMA__.gie_outreach_replies
  FOR UPDATE TO authenticated
  USING (__SCHEMA__.has_tenant_role(tenant_id, 'operator'))
  WITH CHECK (__SCHEMA__.has_tenant_role(tenant_id, 'operator'));
GRANT SELECT ON __SCHEMA__.gie_outreach_replies TO authenticated;
GRANT UPDATE (status) ON __SCHEMA__.gie_outreach_replies TO authenticated;
GRANT ALL ON __SCHEMA__.gie_outreach_replies TO service_role;

NOTIFY pgrst, 'reload schema';
