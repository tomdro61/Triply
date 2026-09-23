/**
 * Read the attribution cookie off an incoming reservation request.
 *
 * Called from POST /api/reservations/pending AFTER the body has been validated
 * and the PaymentIntent retrieved and cross-checked, and from POST
 * /api/reservations after body validation (its PaymentIntent is retrieved
 * inside createBooking). The invalid-cookie Sentry event is therefore gated
 * behind a verified PaymentIntent on the pending route only; on the browser
 * route it is bounded by the once-per-instance latch below.
 *
 * Three outcomes, never a throw:
 *   absent  → null (expected: pre-deploy checkouts, no JS, bots, a newer
 *             cookie version)
 *   valid   → the parsed cookie + GA client id; with analytics opt-out the
 *             click ids and the GA id are stripped
 *   invalid → { v: null, invalid: true } and, on the "checkout" surface only,
 *             ONE Sentry event per lambda instance (fixed message +
 *             fingerprint; the Zod issue goes in context, not the message, so
 *             it groups as a single issue)
 *
 * `surface` gates the Sentry reporting, not the parsing: both surfaces parse
 * and return the cookie identically. Defaults to "checkout" (its only caller
 * for a long time) so existing call sites keep reporting exactly as before.
 * Pass "search" from /api/search: that route is public and bot-reachable, and
 * without this a junk triply_attr cookie there would tag a
 * `booking.step: checkout` Sentry event — with a null PaymentIntent — into
 * the money-path error stream for a request that was never a checkout.
 */

import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";
import {
  ATTR_COOKIE,
  parseAttributionCookie,
  readGaClientId,
  type Attribution,
} from "./schema";
import { stripClickIdsFromCookie } from "./capture";
import { CONSENT_COOKIE, hasAnalyticsOptOutFromCookie } from "@/lib/cookies/consent-server";
import { captureBookingError } from "@/lib/sentry";

let invalidReported = false;

export function __resetInvalidReportForTests(): void {
  invalidReported = false;
}

export function readAttributionFromRequest(
  request: NextRequest,
  context: { stripePaymentIntentId?: string | null },
  surface: "checkout" | "search" = "checkout"
): Attribution | null {
  try {
    const parsed = parseAttributionCookie(request.cookies.get(ATTR_COOKIE)?.value);
    if (parsed.state === "absent") return null;
    if (parsed.state === "invalid") {
      if (surface === "checkout" && !invalidReported) {
        invalidReported = true;
        Sentry.withScope((scope) => {
          scope.setFingerprint(["triply_attr_unparseable"]);
          scope.setTag("booking.step", "checkout");
          scope.setContext("attribution", {
            issue: parsed.issue.slice(0, 200),
            stripePaymentIntentId: context.stripePaymentIntentId ?? null,
          });
          Sentry.captureException(
            new Error("triply_attr cookie present but unparseable — writer/reader drift?")
          );
        });
      }
      return { v: null, invalid: true };
    }
    const optOut = hasAnalyticsOptOutFromCookie(request.cookies.get(CONSENT_COOKIE)?.value);
    if (optOut) {
      // Privacy page: "If you opt out of analytics, advertising click
      // identifiers are not recorded." That must hold for a click id captured
      // BEFORE the opt-out too, so scrub the whole cookie, not just new touches.
      return stripClickIdsFromCookie(parsed.value);
    }
    const gaClientId = readGaClientId(request.cookies.get("_ga")?.value);
    return gaClientId ? { ...parsed.value, ga_client_id: gaClientId } : parsed.value;
  } catch (err) {
    // Attribution must never block a checkout — but a throw HERE is a bug in
    // the reader, not a visitor without a cookie, so it is captured on the
    // checkout surface (guarded so the capture itself can never throw) before
    // resolving to null. Same reasoning as above: /api/search is not a
    // checkout and must not manufacture one in the error stream.
    if (surface === "checkout") {
      try {
        captureBookingError(err instanceof Error ? err : new Error(String(err)), {
          step: "checkout",
        });
      } catch {
        /* Sentry unavailable — nothing further to do */
      }
    }
    return null;
  }
}
