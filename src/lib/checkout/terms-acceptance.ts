/**
 * The words of the checkout terms checkbox, versioned.
 *
 * The Pay button stays disabled until this box is ticked, and every
 * PaymentIntent is stamped with `termsVersion` (lib/stripe/client.ts). So a
 * confirmed PaymentIntent proves the customer agreed to exactly the wording
 * below, at the time of the charge. Dispute evidence quotes it from here.
 *
 * Changing the checkbox wording? Add a NEW version (never edit an old one —
 * past charges agreed to it) and point TERMS_VERSION at it.
 */
export const TERMS_CHECKBOX_TEXT = {
  "2026-11-03":
    "I agree to the Terms of Service and Privacy Policy. I understand that my reservation is subject to the parking " +
    "facility's policies, that I can cancel for free up to 24 hours before check-in (Park Guard protection plans " +
    "are partly non-refundable), and that later cancellations and no-shows may not be refunded.",
} as const;

export type TermsVersion = keyof typeof TERMS_CHECKBOX_TEXT;

export const TERMS_VERSION: TermsVersion = "2026-11-03";

/** The sentence after the two links, as the checkbox renders it. */
export const TERMS_CHECKBOX_TAIL = TERMS_CHECKBOX_TEXT[TERMS_VERSION].replace(
  "I agree to the Terms of Service and Privacy Policy. ",
  ""
);

export function termsTextFor(version: string | null | undefined): string | null {
  return version && Object.hasOwn(TERMS_CHECKBOX_TEXT, version) ? TERMS_CHECKBOX_TEXT[version as TermsVersion] : null;
}

/**
 * The PaymentIntent metadata for the version the BROWSER rendered (the
 * checkout sends it with the create call). Never the server's TERMS_VERSION:
 * a tab opened before a wording change still shows the old words, and the
 * evidence must quote what the customer saw. An unknown or missing version
 * (an old tab, a tampered call) stamps nothing, so the evidence quotes nothing.
 */
export function termsStamp(version: unknown): { termsVersion: TermsVersion } | Record<string, never> {
  return typeof version === "string" && termsTextFor(version) !== null ? { termsVersion: version as TermsVersion } : {};
}
