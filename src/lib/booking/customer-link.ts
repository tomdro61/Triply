/**
 * Who is booking, and may this booking be attached to their account?
 *
 * Background (2026-09-24 fix): the checkout form used to send `userId` in the
 * request body and fulfilment trusted it. When no customer row carried that
 * id, fulfilment looked the customer up BY THE TYPED EMAIL and wrote the
 * supplied user id onto that row. Every booking a signed-in customer can see
 * or self-cancel is whatever `customers` row carries their user id — so anyone
 * with an account could book the cheapest lot under a victim's email and take
 * over the victim's booking history (view + cancel). Two rules close it:
 *
 *   1. Identity comes from the SERVER SESSION, never from the client body.
 *      (`sessionIdentityFromRequest`, used by both reservation routes.)
 *   2. A customer row found by EMAIL is only linked to a user id when that
 *      user's verified auth email is the same address. Booking for someone
 *      else's email is fine — it just doesn't attach their record to you.
 *      Deliberate linking of past guest bookings goes through the verified
 *      claim flow (POST /api/user/link-bookings), which has its own gate.
 *      (`linkableUserIdForEmail`, used by persistBooking.)
 *
 * Load-bearing assumption: `email_confirmed_at` means the address was really
 * confirmed. That is only true while "Confirm email" is ON in the Supabase
 * Auth settings — with it off, Supabase stamps the field at signup and this
 * guard degrades to "whatever the user typed". The claim flow already relies
 * on the same signal; this fix makes it load-bearing on the booking path too.
 *
 * Neither Supabase Auth call below THROWS on failure — both resolve
 * `{ data, error }` — so every failure is handled from `error`, never from a
 * catch. Failures are reported and treated as "don't link"; a booking must
 * never depend on this module.
 */

import { createClient, createAdminClient } from "@/lib/supabase/server";
import { captureBookingError } from "@/lib/sentry";

export interface SessionIdentity {
  userId: string;
  /** The auth email, only when Supabase marks it confirmed; else null. */
  verifiedEmail: string | null;
}

function normalizeEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e.length > 0 ? e : null;
}

/**
 * "No session" is the normal guest case, not a fault. Classified on the
 * stable auth-js `code`, NOT on a bare 401: GoTrue also answers 401 for an
 * invalid/rotated anon key, which is a real fault that must be reported.
 *
 * `AuthSessionMissingError` (the ordinary no-cookie guest) carries NO `code`
 * in auth-js 2.x — errors.js builds it with `code: undefined` — so the `name`
 * check below is load-bearing for the most common path and must not be
 * "simplified" away. The message regex is only a fallback for older GoTrue
 * responses that carry no `code`.
 */
const SIGNED_OUT_CODES = new Set([
  "session_not_found",
  "session_expired", // inactivity timeout / timebox — still just signed out
  "refresh_token_not_found",
  "refresh_token_already_used",
  "bad_jwt",
]);

/** Upper bound on either auth call inside a reservation request. */
export const LOOKUP_TIMEOUT_MS = 4000;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function isSessionMissing(error: {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
}): boolean {
  return (
    error.name === "AuthSessionMissingError" ||
    (error.code !== undefined && SIGNED_OUT_CODES.has(error.code)) ||
    (error.code === undefined &&
      /session missing|invalid.*jwt|jwt expired|refresh token/i.test(error.message ?? ""))
  );
}

/**
 * The signed-in user for this request, from the session cookie. Null for
 * guests and for anything that fails — a booking must never depend on this.
 * `reason` says WHY it is null so the routes can report a real auth fault
 * differently from a plain guest.
 */
export async function sessionIdentityFromRequest(): Promise<
  { identity: SessionIdentity | null; reason: "ok" | "guest" | "auth_error" }
> {
  try {
    const supabase = await createClient();
    // Bounded: on /api/reservations the card already carries a live
    // authorization, and a hung GoTrue would otherwise burn the whole
    // maxDuration budget. A timeout lands in the catch as auth_error.
    const {
      data: { user },
      error,
    } = await withTimeout(supabase.auth.getUser(), LOOKUP_TIMEOUT_MS, "auth.getUser");
    if (error) {
      if (isSessionMissing(error)) return { identity: null, reason: "guest" };
      captureBookingError(
        new Error(`auth.getUser failed (${error.status ?? "?"}): ${error.message}`),
        { step: "checkout" }
      );
      return { identity: null, reason: "auth_error" };
    }
    if (!user) return { identity: null, reason: "guest" };
    const confirmed = Boolean(user.email_confirmed_at);
    return {
      identity: { userId: user.id, verifiedEmail: confirmed ? normalizeEmail(user.email) : null },
      reason: "ok",
    };
  } catch (err) {
    captureBookingError(err instanceof Error ? err : new Error(String(err)), {
      step: "checkout",
    });
    return { identity: null, reason: "auth_error" };
  }
}

export type AuthUserLookup = (userId: string) => Promise<{ verifiedEmail: string | null } | null>;

const adminLookup: AuthUserLookup = async (userId) => {
  const supabase = await createAdminClient();
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error) {
    // A user that genuinely doesn't exist (404) is not a fault; anything else
    // (rotated service key, GoTrue 5xx, timeout) silently disables linking for
    // every booking if it isn't reported.
    const status = (error as { status?: number }).status;
    if (status !== 404) {
      captureBookingError(
        new Error(`auth.admin.getUserById failed (${status ?? "?"}): ${error.message}`),
        { step: "checkout" }
      );
    }
    return null;
  }
  const u = data?.user;
  if (!u) return null;
  return { verifiedEmail: u.email_confirmed_at ? normalizeEmail(u.email) : null };
};

let lookup: AuthUserLookup = adminLookup;

/** Test seam: replace the auth lookup (no network in unit tests). */
export function __setAuthUserLookupForTests(fn: AuthUserLookup | null): void {
  lookup = fn ?? adminLookup;
}

/**
 * Returns `userId` when it is safe to attach a customer row for
 * `customerEmail` to that account — i.e. the account's VERIFIED email is the
 * same address — otherwise null. Never throws.
 *
 * Runs at fulfilment, which happens on the browser path, the Stripe webhook
 * and the sweep cron alike, so it looks the user up via the admin API rather
 * than relying on a request session that only one of those paths has.
 */
export async function linkableUserIdForEmail(
  userId: string | null | undefined,
  customerEmail: string
): Promise<string | null> {
  if (!userId) return null;
  const target = normalizeEmail(customerEmail);
  if (!target) return null;
  try {
    // This runs AFTER the Stripe capture and the ResLab reservation and
    // BEFORE the bookings INSERT. The admin client has no request timeout, so
    // a hung GoTrue would otherwise hold the lambda until maxDuration kills it
    // — money captured, no bookings row, nothing in Sentry (the yb3246 orphan
    // class). Bound it: a slow auth service degrades to "don't link" (the
    // customer can claim via /api/user/link-bookings), never a stalled booking.
    const found = await withTimeout(lookup(userId), LOOKUP_TIMEOUT_MS, "auth user lookup");
    if (!found || !found.verifiedEmail) return null;
    return found.verifiedEmail === target ? userId : null;
  } catch (err) {
    captureBookingError(err instanceof Error ? err : new Error(String(err)), {
      step: "checkout",
    });
    return null;
  }
}

/** Case/space-insensitive email equality, shared with fulfilment. */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeEmail(a);
  const y = normalizeEmail(b);
  return x !== null && x === y;
}
