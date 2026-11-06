import { describe, it, expect } from "vitest";
import { TERMS_CHECKBOX_TAIL, TERMS_CHECKBOX_TEXT, TERMS_VERSION, termsTextFor } from "../terms-acceptance";

describe("terms acceptance", () => {
  it("the rendered tail is the current version minus the linked opening", () => {
    expect(TERMS_CHECKBOX_TEXT[TERMS_VERSION]).toBe(`I agree to the Terms of Service and Privacy Policy. ${TERMS_CHECKBOX_TAIL}`);
    expect(TERMS_CHECKBOX_TAIL).toMatch(/^I understand/);
  });

  // The checkbox customers saw before #150 (stripe-payment-form.tsx JSX, main
  // at 30910b7). Dispute evidence quotes this version as what was ticked, so
  // it must be the words actually rendered.
  it("version 2026-11-03 is word for word what checkout rendered before versioning", () => {
    expect(TERMS_CHECKBOX_TEXT["2026-11-03"]).toBe(
      "I agree to the Terms of Service and Privacy Policy. I understand that my reservation is subject to the parking " +
        "facility's policies, that I can cancel for free up to 24 hours before check-in (Park Guard protection plans " +
        "are partly non-refundable), and that later cancellations and no-shows may not be refunded."
    );
  });

  it("looks up only known versions", () => {
    expect(termsTextFor(TERMS_VERSION)).toBe(TERMS_CHECKBOX_TEXT[TERMS_VERSION]);
    expect(termsTextFor("1999-01-01")).toBeNull();
    expect(termsTextFor(undefined)).toBeNull();
    expect(termsTextFor("toString")).toBeNull();
  });
});
