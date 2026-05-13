import * as Sentry from "@sentry/nextjs";

type BookingErrorContext = {
  lotId?: string;
  step?: "search" | "details" | "checkout" | "confirmation";
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
  }
) {
  Sentry.withScope((scope) => {
    scope.setTag("api.endpoint", context.endpoint);
    scope.setTag("api.method", context.method);
    if (context.statusCode) {
      scope.setTag("api.statusCode", context.statusCode.toString());
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
