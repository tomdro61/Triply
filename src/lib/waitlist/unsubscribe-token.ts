import crypto from "crypto";

/**
 * HMAC-SHA256(row id) so an unsubscribe link needs no session/lookup table —
 * only the sender (who has the signing secret) can produce a valid token for
 * a given row. Keyed on PAYLOAD_SECRET: an existing, already-provisioned
 * server secret, so this doesn't need its own env var. Not a JWT — there's
 * nothing to decode, only a fixed id to match against.
 */
function secret(): string {
  const s = process.env.PAYLOAD_SECRET;
  if (!s) {
    throw new Error("PAYLOAD_SECRET is not configured");
  }
  return s;
}

export function signWaitlistId(id: string): string {
  return crypto.createHmac("sha256", secret()).update(id).digest("hex");
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
