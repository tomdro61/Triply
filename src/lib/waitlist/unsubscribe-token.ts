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
 * the CMS secret isn't set.
 *
 * Read lazily, on first USE, not at module scope: Next evaluates every route
 * module (including this one, imported by all three waitlist routes) during
 * `next build`'s page-data collection, regardless of whether that route ever
 * runs. A module-scope throw here failed EVERY build in any env missing the
 * var — verified locally (pass-3 review item 1) — which is worse than the
 * failure this was trying to prevent. Feature-scoped instead, matching
 * `parkguard/client.ts`'s PARKGUARD_API_KEY check: still fails loudly and
 * still reaches Sentry (every caller either has a try/catch that reports via
 * captureAPIError, or — for verifyWaitlistToken, called before either
 * unsubscribe route's try block — surfaces as an unhandled 500 via Next's
 * onRequestError). Never a silent no-op either way.
 */
function requireSigningSecret(): string {
  const value = process.env.WAITLIST_SIGNING_SECRET;
  if (!value) {
    throw new Error(
      "WAITLIST_SIGNING_SECRET is not configured. Set it in all three Vercel " +
        "envs (Production/Preview/Development) and in your local .env.local."
    );
  }
  return value;
}

export function signWaitlistId(id: string): string {
  return crypto.createHmac("sha256", requireSigningSecret()).update(id).digest("hex");
}

export function verifyWaitlistToken(id: string, token: string): boolean {
  // Deliberately OUTSIDE the try/catch below: a missing secret is a config
  // error, not "this token is invalid" — it must propagate and surface
  // loudly, not get folded into the same `return false` as a malformed hex
  // string.
  const expectedHex = signWaitlistId(id);
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, "hex");
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

/**
 * HMAC-SHA256(value), same secret as the unsubscribe token. Used to pseudonymize
 * an email address before it goes into Sentry telemetry (see /api/waitlist's
 * send-cap-exceeded report): a *keyed* hash, so it can't be reversed by
 * hashing guessed addresses and comparing — a plain sha256 of an email
 * cannot make that claim (emails aren't secret inputs; a rainbow table over
 * common addresses would recover most of them). Reuses this module's secret
 * rather than adding a second one.
 */
export function hmacHex(value: string): string {
  return crypto.createHmac("sha256", requireSigningSecret()).update(value).digest("hex");
}

export function waitlistUnsubscribeUrl(id: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";
  const token = signWaitlistId(id);
  const url = new URL("/api/waitlist/unsubscribe", base);
  url.searchParams.set("id", id);
  url.searchParams.set("token", token);
  return url.toString();
}
