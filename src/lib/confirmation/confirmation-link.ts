import { captureBookingError } from "@/lib/sentry";
import { bookingKey } from "./booking-key";

/**
 * The key for the hand-off right after checkout (the caller has already proved
 * it paid). Undefined when it can't be made: the page then opens on the email
 * path, as before keys existed, and the fault is reported. Never throws.
 */
export function handOffBookingKey(confirmationNumber: string): string | undefined {
  try {
    return bookingKey(confirmationNumber);
  } catch (err) {
    captureBookingError(
      new Error(`hand-off without a booking key: ${err instanceof Error ? err.message : String(err)}`),
      { step: "confirmation", confirmationNumber, fingerprint: ["handoff-without-key"] }
    );
    return undefined;
  }
}

/**
 * The "View Booking Details" link in the confirmation email:
 * `/confirmation/{n}?booking_key={key}&email={address}`.
 *
 * The key opens the booking on its own (lib/confirmation/booking-key.ts). The
 * email stays in the link on purpose: after a rollback, a secret rotation or a
 * misconfiguration the link still opens through the email path, as every link
 * sent before the key did. The confirmation page stores both and strips them
 * from the address bar (lib/confirmation/guest-email.ts).
 *
 * A key that can't be made (the secret is missing) never blocks the email: the
 * link goes out without it, and the fault is reported.
 */
export function confirmationLink(
  confirmationNumber: string,
  email: string,
  options: { withKey: boolean }
): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";
  const emailParam = `email=${encodeURIComponent(email)}`;
  if (!options.withKey) return `${appUrl}/confirmation/${confirmationNumber}?${emailParam}`;
  try {
    return `${appUrl}/confirmation/${confirmationNumber}?booking_key=${bookingKey(confirmationNumber)}&${emailParam}`;
  } catch (err) {
    captureBookingError(
      new Error(
        `confirmation email link sent without its booking key: ${err instanceof Error ? err.message : String(err)}`
      ),
      { step: "confirmation", confirmationNumber, fingerprint: ["confirmation-link-without-key"] }
    );
    return `${appUrl}/confirmation/${confirmationNumber}?${emailParam}`;
  }
}
