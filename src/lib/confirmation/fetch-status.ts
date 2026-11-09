/**
 * What the confirmation page shows for each answer from
 * GET /api/reservations/[id]. Pure, so the screens are unit-tested.
 */

export type ConfirmationFetchStatus =
  | "ok"
  | "auth-required"
  | "not-found"
  | "too-many-tries"
  | "unavailable"
  | "error";

/** The page's state for an HTTP status. */
export function fetchStatusFor(httpStatus: number): ConfirmationFetchStatus {
  if (httpStatus >= 200 && httpStatus < 300) return "ok";
  if (httpStatus === 403) return "auth-required";
  if (httpStatus === 404) return "not-found";
  // The email path's try limit.
  if (httpStatus === 429) return "too-many-tries";
  // The server can't check a guest's proof (a configuration fault).
  if (httpStatus === 503) return "unavailable";
  return "error";
}

export interface ConfirmationErrorScreen {
  headline: string;
  message: string;
  /** Show the confirmation number (the customer can quote it to support). */
  showNumber: boolean;
  /** Offer sign-in (only to a visitor who isn't signed in). */
  showSignIn: boolean;
  /** Offer the "enter the email you booked with" box. Never after too many tries: it would only invite more refusals. */
  showEmailBox: boolean;
}

export function confirmationErrorScreen(
  status: Exclude<ConfirmationFetchStatus, "ok">,
  signedIn: boolean
): ConfirmationErrorScreen {
  switch (status) {
    case "auth-required":
      return {
        headline: "Open Your Confirmation Link",
        message:
          "To view this booking, please open the confirmation email we sent you and click the View Booking Details button. The link includes the verification we need to load your reservation.",
        showNumber: false,
        showSignIn: false,
        showEmailBox: !signedIn,
      };
    case "too-many-tries":
      return {
        headline: "Too Many Tries",
        message:
          "If you just paid, your booking is confirmed: your confirmation email has a link that opens it. You can also sign in or create an account with the email you booked with, or try again later.",
        showNumber: true,
        showSignIn: !signedIn,
        showEmailBox: false,
      };
    case "unavailable":
      return {
        headline: "We Can't Open This Booking Right Now",
        message:
          "If you just paid, your booking is confirmed: your confirmation email has the details. Please try again in a few minutes, or sign in with the email you booked with.",
        showNumber: true,
        showSignIn: !signedIn,
        showEmailBox: false,
      };
    case "error":
      return {
        headline: "Something Went Wrong",
        message: "We had trouble loading your booking. Please try again in a moment, or use the link in your confirmation email.",
        showNumber: false,
        showSignIn: false,
        showEmailBox: false,
      };
    case "not-found":
      return {
        headline: "Booking Not Found",
        message:
          "We couldn't find details for this confirmation. The booking may have been cancelled or the confirmation number is incorrect.",
        showNumber: false,
        showSignIn: false,
        showEmailBox: false,
      };
  }
}
