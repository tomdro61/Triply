import { productionAirports } from "@/config/airports";

/** Same subject the /contact dropdown already offers, so the inbox filter is unchanged. */
export const PARTNER_INQUIRY_SUBJECT = "Partnership Inquiry";
export const OTHER_AIRPORT = "OTHER";
export const PARTNER_NOTES_MAX = 3000;

export interface PartnerInquiryFields {
  name: string;
  email: string;
  phone: string;
  lotName: string;
  airport: string;
  spaces: string;
  notes: string;
}

export function partnerAirportLabel(code: string): string {
  if (code === OTHER_AIRPORT) return "Other / not listed";
  const airport = productionAirports.find((a) => a.code === code);
  return airport ? `${airport.code} (${airport.city}, ${airport.state})` : code;
}

/**
 * /api/contact accepts only name/email/subject/message, so the operator
 * details are folded into the message body as labelled lines: the inbox gets
 * one readable email and no new endpoint or table is needed.
 */
export function buildPartnerInquiryMessage(f: PartnerInquiryFields): string {
  const lines = [
    "Partner inquiry from triplypro.com/partners",
    "",
    `Lot / company: ${f.lotName.trim()}`,
    `Airport: ${partnerAirportLabel(f.airport)}`,
    `Approx. spaces: ${f.spaces.trim() || "not given"}`,
    `Phone: ${f.phone.trim() || "not given"}`,
  ];
  const notes = f.notes.trim().slice(0, PARTNER_NOTES_MAX);
  if (notes) lines.push("", "Notes:", notes);
  return lines.join("\n");
}

/** The exact JSON body POSTed to /api/contact. */
export function buildPartnerInquiryPayload(f: PartnerInquiryFields) {
  return {
    name: f.name,
    email: f.email,
    subject: PARTNER_INQUIRY_SUBJECT,
    message: buildPartnerInquiryMessage(f),
  };
}
