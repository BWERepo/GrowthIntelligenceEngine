// Attribution of a business outcome (lead, meeting, proposal, payment...) to a
// Growth Intelligence prospect. Confidence is "high" only when a stored id links
// the records; an email match is "medium"; no link at all is "unknown". Nothing is guessed.
import type { Attribution, Confidence } from "./metrics";

export type ProspectRef = { id: string; contactEmail: string | null; bweLeadId: string | null; firstContactAt: string | null };
export type LeadRef = { id: string; email: string | null; createdAt: string };

export const normEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase() || null;

export type Link = { prospect: ProspectRef; confidence: Confidence; basis: string; referenceAt: string };
export type Linker = {
  forLead(lead: LeadRef): Link | null;
  /** A BWE customer, known only by the email they onboarded with. */
  forOwnerEmail(email: string | null, eventAt: string): Link | null;
};

/** Indexes prospects and leads once; an email that matches more than one prospect is ambiguous and links to none. */
export function makeLinker(prospects: ProspectRef[], leads: LeadRef[]): Linker {
  const byLeadId = new Map(prospects.filter((p) => p.bweLeadId).map((p) => [p.bweLeadId!, p]));
  const byEmail = new Map<string, ProspectRef | null>();
  for (const p of prospects) {
    const e = normEmail(p.contactEmail);
    if (!e) continue;
    byEmail.set(e, byEmail.has(e) ? null : p);
  }
  const leadByEmail = new Map<string, LeadRef>();
  for (const l of [...leads].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const e = normEmail(l.email);
    if (e && !leadByEmail.has(e)) leadByEmail.set(e, l);
  }
  return {
    forLead(lead) {
      const direct = byLeadId.get(lead.id);
      if (direct) return { prospect: direct, confidence: "high", basis: "The lead is linked to this prospect.", referenceAt: lead.createdAt };
      const e = normEmail(lead.email);
      const byMail = e ? byEmail.get(e) : null;
      if (byMail) return { prospect: byMail, confidence: "medium", basis: "The lead's email address matches the prospect's.", referenceAt: lead.createdAt };
      return null;
    },
    forOwnerEmail(email, eventAt) {
      const e = normEmail(email);
      if (!e) return null;
      const lead = leadByEmail.get(e);
      if (lead) {
        const direct = byLeadId.get(lead.id);
        if (direct) return { prospect: direct, confidence: "medium", basis: "The customer's email matches a lead that is linked to this prospect.", referenceAt: lead.createdAt };
      }
      const byMail = byEmail.get(e);
      if (byMail) return { prospect: byMail, confidence: "medium", basis: "The customer's email matches the prospect's.", referenceAt: lead?.createdAt ?? eventAt };
      return null;
    },
  };
}

export type Attributed = { prospectId: string | null; attribution: Attribution; confidence: Confidence; basis: string | null };
export const UNKNOWN: Attributed = { prospectId: null, attribution: "unknown", confidence: "none", basis: null };

/**
 * First touch: we contacted the business before it first appeared in BWE's records.
 * Assisted: it was already in BWE's records (or we never contacted it) and the link is recorded.
 * Last touch needs touch history from other channels and is not derived here.
 */
export function attributeTo(link: Link | null): Attributed {
  if (!link) return UNKNOWN;
  const contacted = link.prospect.firstContactAt;
  const first = !!contacted && contacted < link.referenceAt;
  return {
    prospectId: link.prospect.id,
    attribution: first ? "first_touch" : "assisted",
    confidence: link.confidence,
    basis: `${link.basis} ${first ? "Our first email to them came before they appeared in BWE's records." : contacted ? "They were already in BWE's records before our first email." : "No email from us is recorded."}`.slice(0, 200),
  };
}
