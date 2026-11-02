/**
 * The order of the payment tap: submit → stage → confirm.
 *
 * Pure sequencer, no React and no state, so the one ordering on the money
 * path has unit tests. Background: on 2026-10-28 Apple Pay on staging answered
 * "Unable to show Apple Pay" because the handler awaited the staging call
 * (POST /api/reservations/pending) BEFORE anything touched Stripe. Safari (and
 * Chrome for Google Pay) only opens a wallet sheet while the tap's user
 * activation is live; the round-trip spent it. Stripe.js's own error text
 * prescribes the fix: "call elements.submit() at the top of your submission
 * handler, before any async or long-running code."
 */

/** Shape of Stripe's error as elements.submit() returns it (message is optional there). */
export interface SubmitErrorLike {
  type: string;
  code?: string;
  message?: string;
}

export type PaymentSubmitOutcome<C> =
  /**
   * elements.submit() answered { error }: sheet dismissed / cannot be shown /
   * incomplete card. NOTHING was staged and nothing confirmed.
   */
  | { step: "submit"; error: SubmitErrorLike }
  /**
   * The stage call threw (incl. the 409 already_authorized hand-off, which
   * throws after router.replace). confirm was NOT called.
   */
  | { step: "stage"; error: unknown; selectedPaymentMethod?: string }
  /** confirmPayment ran; its result (error or paymentIntent) passes through. */
  | { step: "confirm"; result: C; selectedPaymentMethod?: string };

export interface PaymentSubmitDeps<C> {
  /** `elements.submit()` — opens the wallet sheet; validates card fields. */
  submit: () => Promise<{ error?: SubmitErrorLike; selectedPaymentMethod?: string }>;
  /** The staging call (`onBeforeConfirm`). Throws to abort before any charge. */
  stage?: () => Promise<void>;
  /** `stripe.confirmPayment(...)` — its result passes through untouched. */
  confirm: () => Promise<C>;
}

/**
 * ORDER IS THE CONTRACT: submit → stage → confirm, and `submit` is called
 * SYNCHRONOUSLY — no await before it — because it opens the wallet sheet,
 * which the browser only allows inside the tap's activation window.
 *
 * A throw from `submit` or `confirm` propagates to the caller's catch (those are
 * Stripe.js integration errors, reported there); a throw from `stage` is caught
 * HERE and returned as data because the caller words it: the staging call's
 * own customer-facing messages ("…not charged", or the already-authorized
 * hand-off text) pass through, anything else (a network TypeError) gets the
 * caller's own text.
 */
export async function runPaymentSubmit<C>(
  deps: PaymentSubmitDeps<C>
): Promise<PaymentSubmitOutcome<C>> {
  // First statement: nothing may precede it (see the activation-window note).
  const submitted = await deps.submit();
  if (submitted.error) {
    return { step: "submit", error: submitted.error };
  }
  const selectedPaymentMethod = submitted.selectedPaymentMethod;

  if (deps.stage) {
    try {
      await deps.stage();
    } catch (error) {
      return { step: "stage", error, selectedPaymentMethod };
    }
  }

  return { step: "confirm", result: await deps.confirm(), selectedPaymentMethod };
}
