/**
 * What to tell the customer and Sentry when `elements.submit()` answers
 * `{ error }` (see `payment-submit.ts`). Pure, so the classification has tests.
 */
import type { SubmitErrorLike } from "./payment-submit";

/** Shown when Stripe's error carries no message of its own. Nothing was staged
 *  or confirmed at that point, so "not charged" is true. */
export const SUBMIT_FAILED_MESSAGE =
  "We couldn't read your payment details. Please check them and try again — you have not been charged.";

/**
 * Thrown by the staging call when its fetch rejected at the network level
 * (the browser's TypeError: "Failed to fetch" / "Load failed" / "NetworkError
 * when attempting to fetch resource."). Tagged at the source so the form can
 * sort by an allowlist instead of guessing from `name`: a TypeError from a code
 * bug is not a connection problem and must not be worded as one.
 */
export class StageUnreachableError extends Error {
  constructor(cause: unknown) {
    super(
      // NOT the browser's text: the client Sentry init ignores "Failed to
      // fetch" / "Network request failed" by substring (instrumentation-client.ts),
      // and the last exception's message is what that filter reads.
      // "no response", not "never reached": a connection can drop after the
      // request was delivered (a mobile handoff), so the server may have staged
      // the row. Either way confirm does not run for this tap.
      `checkout: staging call got no response from Triply (${cause instanceof Error ? cause.name : typeof cause})`,
      { cause }
    );
    this.name = "StageUnreachableError";
    // Browsers without Error `cause` (Safari < 15, Chrome < 93) drop the option.
    if (this.cause === undefined) this.cause = cause;
  }
}

/**
 * Shown for a StageUnreachableError. confirm never runs after a failed stage,
 * so "not charged" is true for THIS tap — the same claim the staging call's
 * own refusal message makes.
 */
export const STAGE_UNREACHABLE_MESSAGE =
  "We couldn't reach Triply to prepare your booking. Please check your connection and try again — you have not been charged.";

/**
 * Shown instead when an EARLIER tap already reached `confirmPayment`: its
 * response may have been lost (Stripe.js answers `{ error }` on a dropped
 * connection while the authorization went through), and a stage that can't
 * reach the server also can't run the route's 409 already_authorized check.
 * Never "not charged" here.
 */
export const STAGE_UNREACHABLE_AFTER_CONFIRM_MESSAGE =
  "We couldn't reach Triply. If you already tried to pay, please don't pay again — check your email for a confirmation or contact support. Otherwise check your connection and try again.";

/** A stage throw that is neither ours nor a network failure (a code bug). */
export const STAGE_FAILED_MESSAGE =
  "Something went wrong preparing your booking. Please try again — you have not been charged.";

/** Same hedge as above, once a confirm has been attempted. */
export const STAGE_FAILED_AFTER_CONFIRM_MESSAGE =
  "Something went wrong preparing your booking. If you already tried to pay, please don't pay again — check your email for a confirmation or contact support.";

/**
 * Customer-side codes (incomplete / invalid card fields) are not incidents.
 * Everything else — including a dismissed wallet sheet until its code is
 * recorded in the staging walk — is reported, each type/code its own issue.
 * Filtering by CODE, not type, avoids both failure directions: silencing a
 * `validation_error`-typed "unable to show the sheet", or reporting every
 * half-typed card number.
 */
export function shouldReportSubmitError(error: SubmitErrorLike): boolean {
  const code = error.code ?? "";
  return !(code.startsWith("incomplete_") || code.startsWith("invalid_"));
}

/** Sentry message: type/code/message, "-" where Stripe gave none. */
export function submitErrorLabel(error: SubmitErrorLike): string {
  return `elements.submit failed: ${error.type}/${error.code ?? "-"}: ${error.message ?? "-"}`;
}

/** Sentry fingerprint: a dismissal and an "unable to show" stay separate issues. */
export function submitErrorFingerprint(error: SubmitErrorLike): string[] {
  return ["elements-submit", error.type, error.code ?? "-"];
}
