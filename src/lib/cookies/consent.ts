/**
 * Cookie Consent Management
 *
 * Handles GDPR/CCPA compliant cookie consent storage and retrieval.
 */

import Cookies from "js-cookie";

export type CookieConsent = {
  necessary: true; // Always true
  analytics: boolean;
  marketing: boolean;
  timestamp: string;
};

const CONSENT_COOKIE = "triply_cookie_consent";

export function getConsent(): CookieConsent | null {
  const consent = Cookies.get(CONSENT_COOKIE);
  if (!consent) return null;
  try {
    return JSON.parse(consent);
  } catch {
    return null;
  }
}

export function setConsent(
  consent: Omit<CookieConsent, "necessary" | "timestamp">
): CookieConsent {
  const fullConsent: CookieConsent = {
    ...consent,
    necessary: true,
    timestamp: new Date().toISOString(),
  };
  Cookies.set(CONSENT_COOKIE, JSON.stringify(fullConsent), {
    expires: 365,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return fullConsent;
}

export function hasConsent(): boolean {
  return !!getConsent();
}

export function hasAnalyticsConsent(): boolean {
  const consent = getConsent();
  return consent?.analytics ?? false;
}

export function hasMarketingConsent(): boolean {
  const consent = getConsent();
  return consent?.marketing ?? false;
}

export function clearConsent(): void {
  Cookies.remove(CONSENT_COOKIE);
}
