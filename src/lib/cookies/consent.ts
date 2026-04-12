/**
 * Cookie Consent Management — Implied Consent Model
 *
 * Default state is granted. The cookie tracks:
 * - Whether the notice banner has been dismissed
 * - Whether the user has explicitly opted out of analytics (rare)
 */

import Cookies from "js-cookie";

export type CookieConsent = {
  dismissed: boolean;
  analyticsOptOut: boolean;
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

function writeConsent(analyticsOptOut: boolean): CookieConsent {
  const consent: CookieConsent = {
    dismissed: true,
    analyticsOptOut,
    timestamp: new Date().toISOString(),
  };
  Cookies.set(CONSENT_COOKIE, JSON.stringify(consent), {
    expires: 365,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return consent;
}

export function dismissBanner(): CookieConsent {
  return writeConsent(false);
}

export function optOutAnalytics(): CookieConsent {
  return writeConsent(true);
}

export function optInAnalytics(): CookieConsent {
  return writeConsent(false);
}

export function isBannerDismissed(): boolean {
  const consent = getConsent();
  return consent?.dismissed ?? false;
}

export function hasAnalyticsOptOut(): boolean {
  const consent = getConsent();
  return consent?.analyticsOptOut ?? false;
}
