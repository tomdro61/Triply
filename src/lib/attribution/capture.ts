/**
 * Capture-side helpers — pure so they are testable without a route harness.
 *
 * Used by the AttributionCapture client component (decide whether to POST and
 * what) and by POST /api/attribution (merge + size cap + Set-Cookie).
 */

import { getAirportBySlug, getAirportByCode } from "@/config/airports";
import { classifyReferrerHost, normalizeHost } from "./classify";
import {
  ATTR_COOKIE,
  ATTR_COOKIE_MAX_AGE_S,
  ATTR_COOKIE_MAX_BYTES,
  ATTR_STATE_COOKIE,
  FIELD_MAX,
  FIELD_MAX_SHORT,
  LAND_MAX,
  cleanField,
  encodeCookieValue,
  touchHasSignal,
  type AttributionCookie,
  type Touch,
} from "./schema";

/** Paths where a page view must NEVER be treated as a touch. The 3-D Secure
 *  return lands on /checkout/complete from the bank; auth callbacks land on
 *  /auth/*. Both would otherwise overwrite last-touch. Post-acquisition
 *  surfaces (account, reservations, partner, admin) are skipped too: a webmail
 *  referrer on a "your booking" email link is not an acquisition. */
export function isSkippedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/checkout/complete") ||
    pathname.startsWith("/confirmation") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/account") ||
    pathname.startsWith("/reservations") ||
    pathname.startsWith("/partner")
  );
}

/** The airport a page is "about": /search?airport=XXX or an airport/lot page. */
export function pageAirport(pathname: string, search: string): string | null {
  const m = pathname.match(/^\/([^/]+)\/airport-parking(?:\/|$)/);
  if (m) {
    const a = getAirportBySlug(m[1]);
    if (a && !a.isTest) return a.code;
  }
  if (pathname === "/search") {
    const code = new URLSearchParams(search).get("airport");
    if (code) {
      const a = getAirportByCode(code);
      if (a && !a.isTest) return a.code;
    }
  }
  return null;
}

const CLICK_PARAMS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid"] as const;

/** Build the touch for the current page from URL + referrer. Referrer is
 *  reduced to a host and dropped entirely when it is internal (our own site,
 *  Stripe, Google accounts…). Fields are capped HERE, before the POST, so a
 *  long ESP/paid campaign URL is truncated rather than 413'd away. */
export function buildTouch(input: {
  pathname: string;
  search: string;
  referrer: string;
  now?: number;
}): Touch {
  const params = new URLSearchParams(input.search);
  const get = (k: string, max: number) => {
    const v = params.get(k);
    return v ? cleanField(v, max) : undefined;
  };
  let click: string | undefined;
  for (const p of CLICK_PARAMS) {
    const v = get(p, FIELD_MAX);
    if (v) {
      click = cleanField(`${p}:${v}`, FIELD_MAX);
      break;
    }
  }
  const refHost = normalizeHost(input.referrer);
  const refKind = classifyReferrerHost(refHost);
  const ref =
    refKind === "internal" || refKind === "none" ? undefined : cleanField(refHost ?? "", FIELD_MAX);
  const touch: Touch = {
    src: get("utm_source", FIELD_MAX),
    med: get("utm_medium", FIELD_MAX),
    cmp: get("utm_campaign", FIELD_MAX),
    term: get("utm_term", FIELD_MAX_SHORT),
    cnt: get("utm_content", FIELD_MAX_SHORT),
    ref,
    land: cleanField(input.pathname, LAND_MAX),
    click,
    at: Math.floor((input.now ?? Date.now()) / 1000),
  };
  // Drop undefined keys so the object is compact.
  return JSON.parse(JSON.stringify(touch)) as Touch;
}

/** Should the client POST for this page view? */
export function isNewTouch(input: {
  pathname: string;
  touch: Touch;
  /** From the readable state cookie; null when no cookie exists yet. */
  knownAirport: string | null | undefined;
  hasStateCookie: boolean;
  pageAirport: string | null;
}): boolean {
  if (isSkippedPath(input.pathname)) return false;
  if (!input.hasStateCookie) return true;
  if (touchHasSignal(input.touch)) return true;
  if (input.pageAirport && input.pageAirport !== (input.knownAirport ?? null)) return true;
  return false;
}

/** Remove click ids when the visitor has opted out of analytics. UTM and
 *  referrer are order provenance and are kept. */
export function stripClickIds(t: Touch): Touch {
  if (!t.click) return t;
  const { click: _click, ...rest } = t;
  void _click;
  return rest;
}

/** Same, over a whole cookie — an opt-out must also scrub click ids captured
 *  BEFORE the visitor opted out, or the privacy promise is not kept. */
export function stripClickIdsFromCookie(c: AttributionCookie): AttributionCookie {
  return {
    ...c,
    first: stripClickIds(c.first),
    ...(c.last ? { last: stripClickIds(c.last) } : {}),
  };
}

/** Merge a new touch into the existing cookie. `first` is written once and
 *  never overwritten; `last` only on a touch that carries a signal; `apt`
 *  whenever the page has one. */
export function mergeCookie(
  existing: AttributionCookie | null,
  touch: Touch,
  apt: string | null
): AttributionCookie {
  const signal = touchHasSignal(touch);
  const base: AttributionCookie = existing ?? { v: 1, first: touch };
  const next: AttributionCookie = {
    v: 1,
    first: base.first,
    ...(existing && signal ? { last: touch } : existing?.last ? { last: existing.last } : {}),
    ...(apt ? { apt } : base.apt ? { apt: base.apt } : {}),
    ...(base.d ? { d: base.d } : {}),
  };
  return next;
}

/** Enforce the encoded size cap by dropping the least valuable fields in a
 *  fixed order, stopping as soon as it fits. The count of dropped fields is
 *  stamped on the cookie (`d`) so the persisted row shows it was truncated. */
export function fitCookie(value: AttributionCookie): { value: AttributionCookie; dropped: string[] } {
  const dropped: string[] = [];
  let v: AttributionCookie = value;
  const size = () => encodeCookieValue(v).length;
  if (size() <= ATTR_COOKIE_MAX_BYTES) return { value: v, dropped };

  const steps: Array<[string, (c: AttributionCookie) => AttributionCookie]> = [
    ["last", (c) => ({ ...c, last: undefined })],
    ["first.cnt", (c) => ({ ...c, first: { ...c.first, cnt: undefined } })],
    ["first.term", (c) => ({ ...c, first: { ...c.first, term: undefined } })],
    ["first.land", (c) => ({ ...c, first: { ...c.first, land: undefined } })],
    ["first.ref", (c) => ({ ...c, first: { ...c.first, ref: undefined } })],
    ["first.cmp", (c) => ({ ...c, first: { ...c.first, cmp: undefined } })],
    ["first.click", (c) => ({ ...c, first: { ...c.first, click: undefined } })],
  ];
  for (const [name, fn] of steps) {
    v = JSON.parse(JSON.stringify({ ...fn(v), d: (value.d ?? 0) + dropped.length + 1 })) as AttributionCookie;
    dropped.push(name);
    if (size() <= ATTR_COOKIE_MAX_BYTES) break;
  }
  return { value: v, dropped };
}

export interface CookieHeader {
  name: string;
  value: string;
  options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: "lax";
    path: "/";
    maxAge: number;
  };
}

export function buildCookieHeaders(value: AttributionCookie, secure: boolean): CookieHeader[] {
  const shared = { secure, sameSite: "lax" as const, path: "/" as const, maxAge: ATTR_COOKIE_MAX_AGE_S };
  return [
    { name: ATTR_COOKIE, value: encodeCookieValue(value), options: { ...shared, httpOnly: true } },
    // Readable sentinel: "1|JFK" or "1|" — the client uses it to decide whether
    // to POST at all. Never carries touches or click ids.
    { name: ATTR_STATE_COOKIE, value: `1|${value.apt ?? ""}`, options: { ...shared, httpOnly: false } },
  ];
}

export function parseStateCookie(raw: string | undefined | null): { present: boolean; apt: string | null } {
  if (!raw) return { present: false, apt: null };
  const m = raw.match(/^1\|([A-Z]{3})?$/);
  if (!m) return { present: false, apt: null };
  return { present: true, apt: m[1] ?? null };
}
