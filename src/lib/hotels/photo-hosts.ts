/**
 * The ONE allowlist of hotel photo hosts. `safePhotoUrl()` is the only way a
 * LiteAPI image URL reaches an <img>; `next.config.mjs` `images.remotePatterns`
 * and the CSP `img-src` must list the same exact hostnames (no wildcards).
 * A guard test (`__tests__/photo-hosts.test.ts`) fails the build if either file
 * drifts from this list, since next.config.mjs cannot import TypeScript.
 *
 * Phase A crawl (sandbox, 24 Sept 2026, 30 hotels within 6 km of JFK): every
 * `main_photo` / `thumbnail` was on `static.cupid.travel`. Extend by re-running
 * `scripts/liteapi-photo-hosts.mjs` for the pilot airports and pasting the
 * distinct hosts here AND in both config locations.
 */

export const HOTEL_PHOTO_HOSTS: readonly string[] = ["static.cupid.travel"];

const ALLOWED = new Set(HOTEL_PHOTO_HOSTS);

/** Rejections are reported once per host by the caller (rates.ts), not here. */
export interface PhotoUrlResult {
  url: string | null;
  rejectedHost: string | null;
}

/**
 * Returns the URL unchanged when its host is allowlisted and the scheme is
 * https; otherwise `url: null` (render the placeholder) and the host that was
 * rejected so the crawl list can be extended.
 */
export function safePhotoUrl(raw: string | null | undefined): PhotoUrlResult {
  if (!raw) return { url: null, rejectedHost: null };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: null, rejectedHost: "<unparseable>" };
  }
  if (parsed.protocol !== "https:") return { url: null, rejectedHost: parsed.host || "<no-host>" };
  if (!ALLOWED.has(parsed.hostname)) return { url: null, rejectedHost: parsed.hostname };
  return { url: parsed.toString(), rejectedHost: null };
}
