import { describe, it, expect } from "vitest";
import { contactFormSchema } from "@/lib/validation/schemas";
import {
  buildPartnerInquiryMessage,
  buildPartnerInquiryPayload,
  PARTNER_INQUIRY_SUBJECT,
  PARTNER_NOTES_MAX,
  OTHER_AIRPORT,
  partnerInquiryMissingField,
  type PartnerInquiryFields,
} from "../inquiry";

const base: PartnerInquiryFields = {
  name: "Pat Operator",
  email: "pat@example.com",
  phone: "",
  lotName: "Runway Park & Fly",
  airport: "JFK",
  spaces: "",
  notes: "",
};

describe("partner inquiry payload", () => {
  it("passes the /api/contact schema with the Partnership Inquiry subject", () => {
    const payload = buildPartnerInquiryPayload(base);
    expect(payload.subject).toBe(PARTNER_INQUIRY_SUBJECT);
    expect(contactFormSchema.safeParse(payload).success).toBe(true);
  });

  it("folds lot, airport, spaces and phone into the message", () => {
    const msg = buildPartnerInquiryMessage({
      ...base,
      phone: " 555-0100 ",
      spaces: "250",
      notes: "  Covered shuttle lot  ",
    });
    expect(msg).toContain("Lot / company: Runway Park & Fly");
    expect(msg).toMatch(/Airport: JFK \(.+\)/);
    expect(msg).toContain("Approx. spaces: 250");
    expect(msg).toContain("Phone: 555-0100");
    expect(msg).toContain("Notes:\nCovered shuttle lot");
  });

  it("marks optional fields as not given and labels an unlisted airport", () => {
    const msg = buildPartnerInquiryMessage({ ...base, airport: OTHER_AIRPORT });
    expect(msg).toContain("Airport: Other / not listed");
    expect(msg).toContain("Approx. spaces: not given");
    expect(msg).toContain("Phone: not given");
    expect(msg).not.toContain("Notes:");
  });

  it("stays under the route's 5,000-char message cap even when every field blows past its input maxLength", () => {
    // The caps live in the BUILDER (normalizePartnerInquiry), so this holds
    // even if an input's maxLength attribute is removed.
    const payload = buildPartnerInquiryPayload({
      ...base,
      name: "N".repeat(5_000),
      lotName: "L".repeat(5_000),
      phone: "9".repeat(5_000),
      spaces: "1".repeat(5_000),
      notes: "n".repeat(PARTNER_NOTES_MAX + 5_000),
    });
    expect(payload.name).toHaveLength(200);
    expect(payload.message.length).toBeLessThan(5_000);
    expect(contactFormSchema.safeParse(payload).success).toBe(true);
  });

  it("treats whitespace-only required fields as missing and trims what it sends", () => {
    expect(partnerInquiryMissingField({ ...base, name: "   " })).toBe("name");
    expect(partnerInquiryMissingField({ ...base, lotName: "\t" })).toBe("lotName");
    expect(partnerInquiryMissingField({ ...base, airport: "" })).toBe("airport");
    expect(partnerInquiryMissingField(base)).toBeNull();
    const payload = buildPartnerInquiryPayload({ ...base, name: "  Pat Operator  ", email: " pat@example.com " });
    expect(payload.name).toBe("Pat Operator");
    expect(payload.email).toBe("pat@example.com");
  });
});
