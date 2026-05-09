import * as Sentry from "@sentry/nextjs";

type BookingErrorContext = {
  lotId?: string;
  step?: "search" | "details" | "checkout" | "confirmation";
  userId?: string;
  airportCode?: string;
};

export function captureBookingError(
  error: Error,
  context: BookingErrorContext
) {
  Sentry.withScope((scope) => {
    scope.setTag("booking.step", context.step);
    if (context.lotId) scope.setTag("booking.lotId", context.lotId);
    if (context.airportCode) scope.setTag("booking.airport", context.airportCode);
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
    scope.setLevel("error");
    Sentry.captureException(error);
  });
}
