import { productionAirports } from "@/config/airports";

/** Same subject the /contact dropdown already offers, so the inbox filter is unchanged. */
export const PARTNER_INQUIRY_SUBJECT = "Partnership Inquiry";
export const OTHER_AIRPORT = "OTHER";

/**
 * Field caps. The builder enforces them (not just the inputs' maxLength), so
 * the "always under /api/contact's 5,000-char message limit" guarantee holds
 * even if an input attribute is dropped — the test pins the worst case.
 */
export const PARTNER_NAME_MAX = 200;
export const PARTNER_LOT_NAME_MAX = 200;
export const PARTNER_PHONE_MAX = 40;
export const PARTNER_SPACES_MAX = 10;
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

const clip = (s: string, max: number) => s.trim().slice(0, max);

/** Trimmed, capped copy of the fields — what the message and payload are built from. */
export function normalizePartnerInquiry(f: PartnerInquiryFields): PartnerInquiryFields {
  return {
    name: clip(f.name, PARTNER_NAME_MAX),
    email: f.email.trim(),
    phone: clip(f.phone, PARTNER_PHONE_MAX),
    lotName: clip(f.lotName, PARTNER_LOT_NAME_MAX),
    airport: f.airport.trim(),
    spaces: clip(f.spaces, PARTNER_SPACES_MAX),
    notes: clip(f.notes, PARTNER_NOTES_MAX),
  };
}

/** The required fields, after trimming — whitespace-only is not a value. */
export function partnerInquiryMissingField(f: PartnerInquiryFields): "name" | "email" | "lotName" | "airport" | null {
  const n = normalizePartnerInquiry(f);
  if (!n.name) return "name";
  if (!n.email) return "email";
  if (!n.lotName) return "lotName";
  if (!n.airport) return "airport";
  return null;
}

/**
 * /api/contact accepts only name/email/subject/message, so the operator
 * details are folded into the message body as labelled lines: the inbox gets
 * one readable email and no new endpoint or table is needed.
 */
export function buildPartnerInquiryMessage(fields: PartnerInquiryFields): string {
  const f = normalizePartnerInquiry(fields);
  const lines = [
    "Partner inquiry from triplypro.com/partners",
    "",
    `Lot / company: ${f.lotName}`,
    `Airport: ${partnerAirportLabel(f.airport)}`,
    `Approx. spaces: ${f.spaces || "not given"}`,
    `Phone: ${f.phone || "not given"}`,
  ];
  if (f.notes) lines.push("", "Notes:", f.notes);
  return lines.join("\n");
}

/** The exact JSON body POSTed to /api/contact. */
export function buildPartnerInquiryPayload(fields: PartnerInquiryFields) {
  const f = normalizePartnerInquiry(fields);
  return {
    name: f.name,
    email: f.email,
    subject: PARTNER_INQUIRY_SUBJECT,
    message: buildPartnerInquiryMessage(f),
  };
}
