import crypto from "crypto";

/**
 * Thrown when WAITLIST_SIGNING_SECRET is missing. A DISTINCT class (not a bare
 * Error) because callers must be able to tell "this deployment is
 * misconfigured" from "this row/address/token is bad" — the same reason
 * parkguard/client.ts throws a typed MISCONFIGURED error. Without it the cron
 * counted a global config fault as a per-row send failure and burned every
 * row's notify_attempts until the whole backlog was permanently given up on
 * (review pass 4, item 2).
 *
 * `name` is set explicitly so the class survives transpilation and shows up
 * as `WaitlistConfigError` in Sentry rather than a generic `Error`.
 */
export class WaitlistConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaitlistConfigError";
  }
}

/** Narrows an unknown catch value to a config error. Checks `name` as well as
 *  `instanceof`: this module can legitimately be evaluated twice (a fresh
 *  dynamic import in a test, a bundler duplicating the graph), and two
 *  distinct class objects fail `instanceof` against each other. */
export function isWaitlistConfigError(error: unknown): error is WaitlistConfigError {
  return (
    error instanceof WaitlistConfigError ||
    (error instanceof Error && error.name === "WaitlistConfigError")
  );
}

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
 * still reaches Sentry. Every caller now handles WaitlistConfigError
 * explicitly — /api/waitlist and the cron assert it at request entry and
 * return 503, and both unsubscribe handlers wrap verifyWaitlistToken so a
 * config fault renders the branded 500 page instead of Next's raw 500 (which
 * a mail client's one-click POST reads as a deliverability signal). Never a
 * silent no-op anywhere.
 */
function requireSigningSecret(): string {
  const value = process.env.WAITLIST_SIGNING_SECRET;
  if (!value) {
    throw new WaitlistConfigError(
      "WAITLIST_SIGNING_SECRET is not configured. Set it in all three Vercel " +
        "envs (Production/Preview/Development) and in your local .env.local."
    );
  }
  return value;
}

/**
 * Request-entry guard: throws WaitlistConfigError if the secret is missing.
 * Call BEFORE doing any work that a later throw would leave half-done — a
 * waitlist row written with no confirmation email, or a cron loop that
 * charges notify_attempts for a fault that has nothing to do with the row.
 */
export function assertWaitlistSigningSecret(): void {
  requireSigningSecret();
}

export function signWaitlistId(id: string): string {
  return crypto.createHmac("sha256", requireSigningSecret()).update(id).digest("hex");
}

export function verifyWaitlistToken(id: string, token: string): boolean {
  // Deliberately OUTSIDE the try/catch below: a missing secret is a config
  // error, not "this token is invalid" — it must propagate (as a typed
  // WaitlistConfigError the routes branch on) and surface loudly, not get
  // folded into the same `return false` as a malformed hex string.
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
