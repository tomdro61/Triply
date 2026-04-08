declare global {
  interface Window {
    clarity: (...args: unknown[]) => void;
  }
}

/**
 * Grant Clarity cookie consent (call after user accepts analytics cookies)
 */
export function grantClarityConsent() {
  if (typeof window !== "undefined" && window.clarity) {
    window.clarity("consent");
  }
}
