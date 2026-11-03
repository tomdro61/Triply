import { describe, it, expect } from "vitest";
import { TERMS_CHECKBOX_TAIL, TERMS_CHECKBOX_TEXT, TERMS_VERSION, termsTextFor } from "../terms-acceptance";

describe("terms acceptance", () => {
  it("the rendered tail is the current version minus the linked opening", () => {
    expect(TERMS_CHECKBOX_TEXT[TERMS_VERSION]).toBe(`I agree to the Terms of Service and Privacy Policy. ${TERMS_CHECKBOX_TAIL}`);
    expect(TERMS_CHECKBOX_TAIL).toMatch(/^I understand/);
  });

  it("looks up only known versions", () => {
    expect(termsTextFor(TERMS_VERSION)).toBe(TERMS_CHECKBOX_TEXT[TERMS_VERSION]);
    expect(termsTextFor("1999-01-01")).toBeNull();
    expect(termsTextFor(undefined)).toBeNull();
    expect(termsTextFor("toString")).toBeNull();
  });
});
