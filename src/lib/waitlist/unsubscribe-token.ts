import crypto from "crypto";

/**
 * HMAC-SHA256(row id) so an unsubscribe link needs no session/lookup table —
 * only the sender (who has the signing secret) can produce a valid token for
 * a given row. Not a JWT — there's nothing to decode, only a fixed id to
 * match against.
 *
 * Deliberately its OWN env var, not PAYLOAD_SECRET: PAYLOAD_SECRET is a
 * Payload CMS variable (that app's own secret, see triply-cms) that this
 * (main) app has never had configured. Coupling to it would mean a CMS
 * secret rotation silently invalidates every unsubscribe link already
 * sitting in customers' inboxes, and would 500 this route in any env where
 * the CMS secret isn't set. Read once, fail fast: a missing
 * WAITLIST_SIGNING_SECRET must break deploy/boot, not silently no-op every
 * unsubscribe (and, upstream, every send that builds a link with it) at
 * request time.
 */
const WAITLIST_SIGNING_SECRET = (() => {
  const value = process.env.WAITLIST_SIGNING_SECRET;
  if (!value) {
    throw new Error(
      "WAITLIST_SIGNING_SECRET is not configured. Set it in all three Vercel " +
        "envs (Production/Preview/Development) and in your local .env.local."
    );
  }
  return value;
})();

export function signWaitlistId(id: string): string {
  return crypto.createHmac("sha256", WAITLIST_SIGNING_SECRET).update(id).digest("hex");
}

export function verifyWaitlistToken(id: string, token: string): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(signWaitlistId(id), "hex");
  } catch {
    return false;
  }
  let given: Buffer;
  try {
    given = Buffer.from(token, "hex");
  } catch {
    return false;
  }
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

export function waitlistUnsubscribeUrl(id: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";
  const token = signWaitlistId(id);
  const url = new URL("/api/waitlist/unsubscribe", base);
  url.searchParams.set("id", id);
  url.searchParams.set("token", token);
  return url.toString();
}
