import * as Sentry from "@sentry/nextjs";

type BookingErrorContext = {
  lotId?: string;
  step?: "search" | "details" | "checkout" | "confirmation" | "account";
  userId?: string;
  airportCode?: string;
  confirmationNumber?: string;
};

export function captureBookingError(
  error: Error,
  context: BookingErrorContext
) {
  Sentry.withScope((scope) => {
    scope.setTag("booking.step", context.step);
    if (context.lotId) scope.setTag("booking.lotId", context.lotId);
    if (context.airportCode) scope.setTag("booking.airport", context.airportCode);
    if (context.confirmationNumber) {
      // setContext, not setTag — confirmation numbers are per-event unique;
      // using them as tags creates high-cardinality index bloat in Sentry.
      // Clamp to a reasonable length so a malformed path param can't push
      // an unbounded string into Sentry.
      scope.setContext("booking", {
        confirmationNumber: context.confirmationNumber.slice(0, 64),
      });
    }
    if (context.userId) scope.setUser({ id: context.userId });
    Sentry.captureException(error);
  });
}

export function capturePaymentError(
  error: Error,
  context: {
    stripePaymentIntentId?: string;
    amount?: number;
    userId?: string;
  }
) {
  Sentry.withScope((scope) => {
    scope.setTag("payment.error", "true");
    if (context.stripePaymentIntentId) {
      scope.setTag("payment.intentId", context.stripePaymentIntentId);
    }
    if (context.amount) {
      scope.setExtra("payment.amount", context.amount);
    }
    if (context.userId) scope.setUser({ id: context.userId });
    scope.setLevel("error");
    Sentry.captureException(error);
  });
}

export function captureAPIError(
  error: Error,
  context: {
    endpoint: string;
    method: string;
    statusCode?: number;
    /** A sub-step within the endpoint (e.g. a best-effort side write). */
    stage?: string;
    /** An upstream error code (e.g. Postgres SQLSTATE). */
    code?: string;
    /**
     * Free-form diagnostic context attached to the event WITHOUT affecting
     * grouping (unlike the message). Use for per-event detail such as a
     * PostgREST `details`/`hint`, a failing row, or how many times a deduped
     * fault has already occurred on a warm instance (see /api/newsletter).
     * Lands in the "detail" context. (Same shape as PR #31's addition — keep
     * these identical so the two branches merge cleanly.)
     */
    extra?: Record<string, unknown>;
  }
) {
  Sentry.withScope((scope) => {
    scope.setTag("api.endpoint", context.endpoint);
    scope.setTag("api.method", context.method);
    if (context.statusCode) {
      scope.setTag("api.statusCode", context.statusCode.toString());
    }
    if (context.stage) scope.setTag("api.stage", context.stage);
    if (context.code) scope.setContext("api", { code: context.code });
    if (context.extra) {
      scope.setContext("detail", context.extra);
    }
    Sentry.captureException(error);
  });
}

export function captureParkGuardError(
  error: Error,
  context: {
    bookingId?: string;
    reslabReservationNumber?: string;
    operation: "capture" | "update";
    statusCode?: number;
    /**
     * Park Guard's identifier — set when PG returned one but a downstream
     * step failed (e.g., local DB write of pg_identifier failed). Surfaced
     * as a structured context field so ops can recover it programmatically
     * instead of parsing the error message string.
     */
    pgIdentifier?: string;
  }
) {
  Sentry.withScope((scope) => {
    scope.setTag("parkguard.error", "true");
    scope.setTag("parkguard.operation", context.operation);
    if (context.bookingId) scope.setTag("parkguard.bookingId", context.bookingId);
    if (context.reslabReservationNumber) {
      scope.setTag("parkguard.reslabReservationNumber", context.reslabReservationNumber);
    }
    if (context.statusCode) {
      scope.setTag("parkguard.statusCode", context.statusCode.toString());
    }
    if (context.pgIdentifier) {
      scope.setContext("parkguard", { pgIdentifier: context.pgIdentifier });
    }
    scope.setLevel("error");
    Sentry.captureException(error);
  });
}

/**
 * /api/contact dropped a submission because its honeypot field was filled.
 * Info level, one fingerprint: the point is that a drop is never SILENT — a
 * real lead caught by a password manager's identity fill can be found, and
 * the false-positive rate can be read off the event count. No message body,
 * no full address: subject, the address's domain and the IP key only.
 */
// Throttled per instance: a bot hammering the honeypot must not mint one
// Sentry event per request (the TRIPLY-13 flood class). One event per
// HONEYPOT_CAPTURE_INTERVAL_MS, carrying how many drops it stands for.
const HONEYPOT_CAPTURE_INTERVAL_MS = 10 * 60 * 1000;
let lastHoneypotCaptureAt = 0;
let honeypotSuppressed = 0;
/** Tests only. */
export function __resetHoneypotCaptureForTests(): void {
  lastHoneypotCaptureAt = 0;
  honeypotSuppressed = 0;
}
export function captureContactHoneypotDrop(context: { subject: string; emailDomain: string; ipKey: string }) {
  const now = Date.now();
  if (now - lastHoneypotCaptureAt < HONEYPOT_CAPTURE_INTERVAL_MS) {
    honeypotSuppressed++;
    return;
  }
  lastHoneypotCaptureAt = now;
  const suppressedSinceLastCapture = honeypotSuppressed;
  honeypotSuppressed = 0;
  const emailDomain = context.emailDomain.slice(0, 100); // caller text; keep the title bounded
  Sentry.withScope((scope) => {
    scope.setLevel("info");
    scope.setTag("contact.honeypot", "true");
    scope.setFingerprint(["contact", "honeypot-drop"]);
    scope.setContext("contact", { ...context, emailDomain, suppressedSinceLastCapture });
    Sentry.captureMessage(
      `Contact form submission dropped by honeypot (${context.subject || "no subject"}, @${emailDomain || "?"}; +${suppressedSinceLastCapture} suppressed)`
    );
  });
}

/**
 * A Stripe payment on our account that did NOT come from checkout — a Payment
 * Link, a dashboard charge, a manual invoice. Nothing to fulfil, nothing wrong.
 * Recorded at info level under its own fingerprint so it is visible without
 * paging as a "cannot fulfil" error (TRIPLY-24 was a $4.74 Payment Link).
 */
export function captureNonCheckoutPayment(context: {
  stripePaymentIntentId: string;
  amount: number;
  eventType: string;
}) {
  Sentry.withScope((scope) => {
    scope.setLevel("info");
    scope.setTag("payment.nonCheckout", "true");
    scope.setTag("payment.intentId", context.stripePaymentIntentId);
    scope.setFingerprint(["payment", "non-checkout"]);
    scope.setContext("payment", {
      amount: context.amount,
      eventType: context.eventType,
    });
    Sentry.captureMessage(
      `Non-checkout Stripe payment received (${context.eventType}, $${context.amount.toFixed(2)}) — no lotId metadata, no staged booking; nothing to fulfil`
    );
  });
}

/**
 * The pre-charge "lot-declared fields" check in /api/reservations/pending.
 *
 * Deliberately NOT capturePaymentError: nothing here is a payment failure, and
 * on a bad ResLab afternoon a skip fires on every checkout — filed as
 * `payment.error` it would bury the real ones. Warning level and its own tag;
 * the PaymentIntent id stays a tag so a skip can be matched to a later
 * fulfilment failure for the same payment.
 *
 * Grouping: skips are one issue (they follow ResLab's health, not a lot). A
 * refusal or a missing lot is grouped PER LOT, so a lot that starts turning
 * customers away opens its own issue instead of adding events to an old one.
 */
export function captureRequiredFieldCheck(
  outcome: "skipped" | "refused" | "lot_not_found",
  message: string,
  context: {
    stripePaymentIntentId: string;
    locationId: number;
    /** Field names, a ResLab status, a parse issue — never customer answers. */
    detail?: Record<string, unknown>;
  }
) {
  Sentry.withScope((scope) => {
    scope.setLevel("warning");
    scope.setTag("check", "required_extra_fields");
    scope.setTag("check.outcome", outcome);
    scope.setTag("payment.intentId", context.stripePaymentIntentId);
    scope.setTag("booking.lotId", String(context.locationId));
    scope.setFingerprint(
      outcome === "skipped"
        ? ["required-extra-fields", outcome]
        : ["required-extra-fields", outcome, String(context.locationId)]
    );
    if (context.detail) scope.setContext("detail", context.detail);
    Sentry.captureException(new Error(message));
  });
}
