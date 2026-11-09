import crypto from "crypto";

/**
 * The signed key on a confirmation link (/confirmation/{n}?booking_key=…).
 *
 * A guest who is not signed in opens their booking with this key, or with the
 * checkout email (capped — see guest-lookup-limit.ts). The key is the first 16
 * bytes of an HMAC-SHA256 over the confirmation number, as base64url (22
 * characters), so only a holder of BOOKING_LINK_SIGNING_SECRET can make one.
 * The HMAC input is domain-prefixed ("booking-view:v1:") so a value made with
 * the same secret for anything else (the limiter's bucket hashes) never verifies.
 *
 * No expiry, and derived from the number alone: every send of the same email
 * carries a byte-identical link.
 *
 * Its own secret, different in Production, Preview and Development: staging's
 * ResLab has its own counter, so a staging number can equal a production one.
 * Read lazily on first use, never at module scope. Missing → a typed
 * BookingLinkConfigError every caller handles explicitly. Vercel builds refuse
 * to start without it (next.config.mjs).
 */

export class BookingLinkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingLinkConfigError";
  }
}

/** `instanceof` plus `name`: this module can be evaluated twice (a fresh
 *  dynamic import in a test, a duplicated bundle graph). */
export function isBookingLinkConfigError(error: unknown): error is BookingLinkConfigError {
  return (
    error instanceof BookingLinkConfigError ||
    (error instanceof Error && error.name === "BookingLinkConfigError")
  );
}

/** The secret, or throw BookingLinkConfigError. Shared with the limiter's bucket hashes. */
export function requireBookingLinkSecret(): string {
  const value = process.env.BOOKING_LINK_SIGNING_SECRET;
  if (!value) {
    throw new BookingLinkConfigError(
      "BOOKING_LINK_SIGNING_SECRET is not configured. Set it in all three Vercel " +
        "envs (Production/Preview/Development), each with a different value."
    );
  }
  return value;
}

const DOMAIN = "booking-view:v1:";
const KEY_BYTES = 16;
/** 16 bytes as unpadded base64url. */
export const BOOKING_KEY_SHAPE = /^[A-Za-z0-9_-]{22}$/;

function mac(reservationNumber: string): Buffer {
  return crypto
    .createHmac("sha256", requireBookingLinkSecret())
    .update(DOMAIN + reservationNumber)
    .digest()
    .subarray(0, KEY_BYTES);
}

/** The key for this exact confirmation number string. Throws BookingLinkConfigError. */
export function bookingKey(reservationNumber: string): string {
  if (!reservationNumber) throw new Error("bookingKey: a confirmation number is required");
  return mac(reservationNumber).toString("base64url");
}

/**
 * True only for the key made for this number. A wrong shape is false before
 * any HMAC is computed. A missing secret is NOT "a bad key": it throws
 * BookingLinkConfigError so the caller reports a config fault.
 */
export function verifyBookingKey(reservationNumber: string, key: string): boolean {
  if (!reservationNumber || !BOOKING_KEY_SHAPE.test(key)) return false;
  // Compare the TEXT, not decoded bytes: 22 base64url characters carry 4 bits
  // more than 16 bytes, and a decoder ignores them, so two strings can decode
  // alike. Both sides are 22 ASCII characters here.
  const expected = Buffer.from(mac(reservationNumber).toString("base64url"));
  const given = Buffer.from(key);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
