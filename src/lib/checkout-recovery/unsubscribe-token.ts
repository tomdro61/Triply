import { signWaitlistId, verifyWaitlistToken } from "@/lib/waitlist/unsubscribe-token";

/**
 * Unsubscribe tokens for checkout-recovery emails.
 *
 * Reuses the waitlist HMAC (WAITLIST_SIGNING_SECRET) rather than adding a new
 * secret, with a domain prefix so a token minted for a waitlist row id can
 * never verify here (or the reverse), even though both are UUIDs. A missing
 * secret throws WaitlistConfigError, exactly like the waitlist routes — callers
 * branch on isWaitlistConfigError.
 */
const DOMAIN = "checkout-recovery:";

export function signRecoveryId(id: string): string {
  return signWaitlistId(`${DOMAIN}${id}`);
}

export function verifyRecoveryToken(id: string, token: string): boolean {
  return verifyWaitlistToken(`${DOMAIN}${id}`, token);
}

export function recoveryUnsubscribeUrl(id: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";
  const url = new URL("/api/checkout-recovery/unsubscribe", base);
  url.searchParams.set("id", id);
  url.searchParams.set("token", signRecoveryId(id));
  return url.toString();
}
