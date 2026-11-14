// Turns an approved draft into the exact text that is sent. Pure.
import { MAILING_ADDRESS_MARKER, UNSUBSCRIBE_MARKER } from "@/lib/providers/ai/anthropic.server";

export type ComposeInput = { subject: string; body: string; unsubscribeUrl: string; mailingAddress: string };
export type Composed = { subject: string; text: string; headers: Record<string, string> };

export function composeOutreach(i: ComposeInput): Composed {
  if (!i.body.includes(UNSUBSCRIBE_MARKER)) throw new Error("The draft has no unsubscribe line, so it cannot be sent.");
  if (!i.body.includes(MAILING_ADDRESS_MARKER)) throw new Error("The draft has no mailing address line, so it cannot be sent.");
  if (!i.mailingAddress.trim()) throw new Error("BWE's mailing address is not set, so nothing can be sent.");
  const text = i.body.split(UNSUBSCRIBE_MARKER).join(i.unsubscribeUrl).split(MAILING_ADDRESS_MARKER).join(i.mailingAddress.trim());
  if (/\{\{[^}]*\}\}/.test(text)) throw new Error("The draft still has an unfilled placeholder, so it cannot be sent.");
  return { subject: i.subject.trim(), text, headers: { "List-Unsubscribe": `<${i.unsubscribeUrl}>` } };
}

/** BWE's mailing address (never the physical address), as one line. */
export function formatMailingAddress(r: { mailing_address?: string | null; mailing_city?: string | null; mailing_state?: string | null; mailing_zip?: string | null }): string {
  return [r.mailing_address, [r.mailing_city, r.mailing_state, r.mailing_zip].filter(Boolean).join(" ")].map((x) => (x ?? "").trim()).filter(Boolean).join(", ");
}
