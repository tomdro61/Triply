import crypto from "crypto";

/**
 * Signed links for the post-trip review email (/review/{token}).
 *
 * The token carries the booking id and an expiry, and an HMAC-SHA256 over
 * both, so a review link needs no session and no lookup table — only the
 * sender (who holds REVIEW_SIGNING_SECRET) can mint one for a given booking,
 * and a link stops working after its expiry.
 *
 * Format: `{bookingId}.{expSeconds}.{base64url(hmac)}`, where the HMAC input
 * is domain-prefixed ("post-trip-review:v1:") so a signature minted for any
 * other purpose can never verify here.
 *
 * Its OWN secret, mirroring WAITLIST_SIGNING_SECRET (see
 * src/lib/waitlist/unsubscribe-token.ts): rotating the waitlist secret must not
 * kill every review link in customers' inboxes, and vice versa. Read lazily on
 * first use, never at module scope, so `next build` does not fail in an env
 * that lacks it. Missing → a typed ReviewConfigError that every caller handles
 * explicitly (cron 503, page error state, API 503). Never a silent fallback.
 */

export class ReviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewConfigError";
  }
}

/** `instanceof` plus `name`: this module can be evaluated twice (a fresh
 *  dynamic import in a test, a duplicated bundle graph). */
export function isReviewConfigError(error: unknown): error is ReviewConfigError {
  return (
    error instanceof ReviewConfigError ||
    (error instanceof Error && error.name === "ReviewConfigError")
  );
}

function requireSigningSecret(): string {
  const value = process.env.REVIEW_SIGNING_SECRET;
  if (!value) {
    throw new ReviewConfigError(
      "REVIEW_SIGNING_SECRET is not configured. Set it in all three Vercel " +
        "envs (Production/Preview/Development) and in your local .env.local."
    );
  }
  return value;
}

/** Request-entry guard: throws ReviewConfigError when the secret is missing. */
export function assertReviewSigningSecret(): void {
  requireSigningSecret();
}

const DOMAIN = "post-trip-review:v1:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A review link stays valid this many days after the trip's check-out date. */
export const REVIEW_LINK_VALID_DAYS = 60;

function hmac(bookingId: string, expSeconds: number): Buffer {
  return crypto
    .createHmac("sha256", requireSigningSecret())
    .update(`${DOMAIN}${bookingId.toLowerCase()}:${expSeconds}`)
    .digest();
}

/**
 * The expiry for a booking's review links: the end of the 60th day after the
 * check-out DATE. Derived from the booking (never from "now") so every send of
 * the same email — first try, retry, reminder — carries a byte-identical link,
 * which the Resend idempotency key depends on. Pure calendar arithmetic on the
 * literal "YYYY-MM-DD" (UTC calendar, no zone conversion of the booking time).
 */
export function reviewLinkExpiry(checkoutDate: string): number {
  const m = DATE_RE.exec(checkoutDate);
  if (!m) throw new Error(`reviewLinkExpiry: not a YYYY-MM-DD date: ${checkoutDate}`);
  const startOfDay = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(startOfDay / 1000) + (REVIEW_LINK_VALID_DAYS + 1) * 86_400;
}

export function signReviewToken(bookingId: string, expSeconds: number): string {
  if (!UUID_RE.test(bookingId)) throw new Error("signReviewToken: booking id is not a UUID");
  if (!Number.isSafeInteger(expSeconds) || expSeconds <= 0) {
    throw new Error("signReviewToken: expiry must be a positive integer of seconds");
  }
  const id = bookingId.toLowerCase();
  return `${id}.${expSeconds}.${hmac(id, expSeconds).toString("base64url")}`;
}

export type ReviewTokenResult =
  | { ok: true; bookingId: string; expSeconds: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verifies a token. A missing secret is NOT "invalid token": it throws
 * ReviewConfigError (outside any catch) so callers surface a config fault
 * instead of telling a customer their link is bad.
 */
export function verifyReviewToken(token: string, nowMs: number): ReviewTokenResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [bookingId, expRaw, sig] = parts;
  if (!UUID_RE.test(bookingId) || !/^\d{1,12}$/.test(expRaw) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) {
    return { ok: false, reason: "malformed" };
  }
  const expSeconds = Number(expRaw);
  const expected = hmac(bookingId.toLowerCase(), expSeconds);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  // Checked AFTER the signature, so "expired" is only ever said about a link
  // we actually issued.
  if (nowMs >= expSeconds * 1000) return { ok: false, reason: "expired" };
  return { ok: true, bookingId: bookingId.toLowerCase(), expSeconds };
}

function appBase(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com").replace(/\/$/, "");
}

/** `/review/{token}`, plus `?r=N` for a star link (records the tap on landing). */
export function reviewUrl(token: string, rating?: number): string {
  const url = new URL(`/review/${encodeURIComponent(token)}`, appBase());
  if (rating !== undefined) url.searchParams.set("r", String(rating));
  return url.toString();
}
