declare global {
  interface Window {
    clarity: (...args: unknown[]) => void;
  }
}

/**
 * Grant Clarity cookie consent
 */
export function grantClarityConsent() {
  if (typeof window !== "undefined" && window.clarity) {
    window.clarity("consent");
  }
}

/**
 * Revoke Clarity cookie consent and stop tracking
 */
export function revokeClarityConsent() {
  if (typeof window !== "undefined" && window.clarity) {
    window.clarity("consent", false);
  }
}
