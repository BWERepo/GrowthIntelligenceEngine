// Who outreach appears to come from. The mailbox login and password stay Worker secrets
// (never stored in the database); these settings only choose the visible sender.
export const DEFAULT_FROM_NAME = "Business Web Express";

export type MailSettings = { fromName: string; fromEmail: string | null; replyTo: string | null };
export const DEFAULT_MAIL_SETTINGS: MailSettings = { fromName: DEFAULT_FROM_NAME, fromEmail: null, replyTo: null };

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export type MailSettingsCheck = { ok: true; value: MailSettings } | { ok: false; error: string };

/** Trims and checks what the owner typed. Empty address fields mean "use the mailbox login". */
export function checkMailSettings(input: { fromName: string; fromEmail: string; replyTo: string }): MailSettingsCheck {
  const fromName = input.fromName.trim().replace(/\s+/g, " ");
  if (fromName.length < 1 || fromName.length > 80 || /[\r\n<>"]/.test(fromName)) {
    return { ok: false, error: "The sender name must be 1 to 80 characters, with no quotes or angle brackets." };
  }
  const address = (raw: string, label: string): { ok: true; value: string | null } | { ok: false; error: string } => {
    const v = raw.trim().toLowerCase();
    if (!v) return { ok: true, value: null };
    if (v.length > 254 || !EMAIL.test(v)) return { ok: false, error: `${label} is not a valid email address.` };
    return { ok: true, value: v };
  };
  const from = address(input.fromEmail, "The send-as address");
  if (!from.ok) return from;
  const reply = address(input.replyTo, "The reply-to address");
  if (!reply.ok) return reply;
  return { ok: true, value: { fromName, fromEmail: from.value, replyTo: reply.value } };
}

/** The address shown in the From line: the owner's choice, else the mailbox login. */
export function effectiveFrom(loginUser: string | null | undefined, settings: MailSettings): string | null {
  return settings.fromEmail ?? loginUser ?? null;
}
