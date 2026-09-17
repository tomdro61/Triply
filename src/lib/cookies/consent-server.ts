/**
 * Server-side reader for the `triply_cookie_consent` cookie.
 *
 * consent.ts is client-only (js-cookie). The attribution route needs the
 * opt-out flag on the server so click ids are dropped at WRITE time, not just
 * at persist time — an opted-out visitor should never carry a gclid in a
 * first-party cookie at all.
 */

export const CONSENT_COOKIE = "triply_cookie_consent";

export function hasAnalyticsOptOutFromCookie(raw: string | undefined | null): boolean {
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { analyticsOptOut?: unknown }).analyticsOptOut === true
    );
  } catch {
    return false;
  }
}
