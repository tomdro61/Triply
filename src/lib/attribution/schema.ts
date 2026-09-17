/**
 * Booking attribution — the shared shape of the `triply_attr` cookie.
 *
 * ONE schema for both the writer (POST /api/attribution) and the readers
 * (/api/reservations/pending, /api/reservations). A writer/reader drift is the
 * failure that would silently NULL every booking's attribution, so the reader
 * distinguishes three states and the "invalid" one is Sentry-flagged:
 *
 *   absent  → the cookie was never set (pre-deploy, no JS, bots) — expected.
 *             ALSO the outcome for a cookie written by a NEWER version of this
 *             code (unknown `v`): during a rolling deploy / after a rollback
 *             that is not a bug, so it is replaced without an alarm.
 *   valid   → parsed object. Unknown keys are STRIPPED, not rejected, so a
 *             future additive field never invalidates today's readers.
 *   invalid → the cookie exists but does not parse — a bug, never silent.
 *
 * Attribution NEVER blocks a checkout: every failure resolves to one of these.
 *
 * Size discipline: browsers silently drop any cookie over 4 KB, and the
 * Supabase auth cookies already use most of the header budget, so every field
 * is capped and the encoded cookie is held under ATTR_COOKIE_MAX_BYTES.
 */

import { z } from "zod";
import {
  ATTR_COOKIE,
  ATTR_COOKIE_MAX_AGE_S,
  ATTR_COOKIE_MAX_BYTES,
  ATTR_COOKIE_VERSION,
  ATTR_STATE_COOKIE,
} from "./constants";

export { ATTR_COOKIE, ATTR_COOKIE_MAX_AGE_S, ATTR_COOKIE_MAX_BYTES, ATTR_COOKIE_VERSION, ATTR_STATE_COOKIE };

export const FIELD_MAX = 100;
export const FIELD_MAX_SHORT = 64;
export const LAND_MAX = 120;

/** Strip C0 control characters only. Deliberately NOT stripping leading
 *  `=+-@` — that corrupts legitimate values like "-summer"; CSV formula safety
 *  is handled at export (src/lib/utils/csv.ts). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
export function cleanField(value: string, max: number): string | undefined {
  const t = value.replace(CONTROL_CHARS, "").trim().slice(0, max);
  return t.length > 0 ? t : undefined;
}
const clean = (max: number) =>
  z
    .string()
    // An empty value is "absent", never a validation failure — a stray
    // `utm_source=` must not invalidate the whole cookie.
    .transform((s) => cleanField(s, max))
    .optional();

export const touchSchema = z.object({
  src: clean(FIELD_MAX),
  med: clean(FIELD_MAX),
  cmp: clean(FIELD_MAX),
  term: clean(FIELD_MAX_SHORT),
  cnt: clean(FIELD_MAX_SHORT),
  /** Referrer HOST only, never the full URL. */
  ref: clean(FIELD_MAX),
  /** Landing pathname, no query. */
  land: clean(LAND_MAX),
  /** "<param>:<value>" for the first click id present, e.g. "gclid:abc". */
  click: clean(FIELD_MAX),
  /** Epoch seconds. */
  at: z.number().int().nonnegative(),
});

export type Touch = z.infer<typeof touchSchema>;

const airportCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .optional();

/** The cookie payload as written by the server. Unknown keys are stripped
 *  (forward-compatible); the version is checked separately so a newer format
 *  reads as "absent", not "invalid". */
export const attributionCookieSchema = z.object({
  v: z.literal(ATTR_COOKIE_VERSION),
  first: touchSchema,
  last: touchSchema.optional(),
  /** Last airport the visitor searched or viewed. */
  apt: airportCodeSchema,
  /** Number of fields the size cap dropped when this cookie was written (see
   *  fitCookie). Absent = nothing dropped. Lets a row show it was truncated. */
  d: z.number().int().positive().optional(),
});

export type AttributionCookie = z.infer<typeof attributionCookieSchema>;

/** What gets persisted on pending_bookings / bookings: the cookie plus an
 *  optional GA4 client id, OR the invalid marker. Derived from a schema so the
 *  module can re-parse what it wrote (a DB read-back is a boundary too). */
export const persistedAttributionSchema = z.union([
  attributionCookieSchema.extend({
    ga_client_id: z.string().regex(/^\d+\.\d+$/).optional(),
  }),
  z.object({ v: z.null(), invalid: z.literal(true) }),
]);
export type Attribution = z.infer<typeof persistedAttributionSchema>;

/** Validate a JSONB value read back from the database. Never throws: an
 *  unparseable value becomes the invalid marker (reports as "invalid"), null
 *  stays null. */
export function normalizeStoredAttribution(raw: unknown): Attribution | null {
  if (raw === null || raw === undefined) return null;
  const parsed = persistedAttributionSchema.safeParse(raw);
  return parsed.success ? parsed.data : { v: null, invalid: true };
}

export { CHANNELS, isChannel } from "./constants-channels";
export type { Channel } from "./constants-channels";

export type ParsedCookie =
  | { state: "absent" }
  | { state: "valid"; value: AttributionCookie }
  | { state: "invalid"; issue: string };

/** Cookie value encoding: base64url of compact JSON. Cookie-safe (no `;`, `,`,
 *  spaces or quotes) and ~1.33× the JSON size — far better than
 *  percent-encoding, which roughly triples it. */
export function encodeCookieValue(value: AttributionCookie): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function parseAttributionCookie(raw: string | undefined | null): ParsedCookie {
  if (raw === undefined || raw === null || raw === "") return { state: "absent" };
  if (raw.length > ATTR_COOKIE_MAX_BYTES * 2) {
    return { state: "invalid", issue: "cookie too long" };
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return { state: "invalid", issue: "not base64url JSON" };
  }
  // A well-formed cookie from a NEWER writer is not corruption: treat it as
  // absent so the reader replaces it silently instead of raising the drift alarm.
  if (
    typeof json === "object" &&
    json !== null &&
    typeof (json as { v?: unknown }).v === "number" &&
    (json as { v: number }).v > ATTR_COOKIE_VERSION
  ) {
    return { state: "absent" };
  }
  const parsed = attributionCookieSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      state: "invalid",
      issue: `${issue?.path.join(".") || "root"}: ${issue?.message ?? "unknown"}`,
    };
  }
  return { state: "valid", value: parsed.data };
}

/**
 * GA4 client id from the `_ga` cookie. GA4 stores exactly `GA1.<n>.<random>.<timestamp>`
 * and its client id (the value exported as user_pseudo_id) is the LAST TWO
 * segments joined — not just `<random>`. The prefix and segment count are
 * enforced so a tampered value can never become a plausible-looking join key.
 */
export function readGaClientId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  if (parts[0] !== "GA1" || !/^\d+$/.test(parts[1])) return null;
  const [, , a, b] = parts;
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
  return `${a}.${b}`;
}

/** Does this touch carry any acquisition signal (UTM, click id, referrer)? */
export function touchHasSignal(t: Touch): boolean {
  return Boolean(t.src || t.med || t.cmp || t.click || t.ref);
}
