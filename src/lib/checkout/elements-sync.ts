/**
 * Re-syncing the Stripe Payment Element after the server changed the
 * PaymentIntent's amount (a protection-plan pick goes through
 * /api/checkout/lot/update-pi).
 *
 * The Element learns the amount once, when it mounts. A card charge is the
 * server amount regardless, but the Apple Pay / Google Pay sheet shows the
 * amount the Element knows — so after an update it would show the OLD total.
 * Stripe's documented fix is `elements.fetchUpdates()`; this module normalises
 * its failure shapes (resolves with `{ error }`, rejects, or never settles)
 * into one outcome the form can act on.
 */

export type ElementsSyncOutcome = { ok: true } | { ok: false; message: string };

/** The subset of `StripeElements` the sync needs. */
export interface ElementsLike {
  fetchUpdates(): Promise<{ error?: { message: string; status?: string } }>;
}

/**
 * A stalled request would otherwise leave Pay on "Updating total…" for good
 * with no Try again on screen (the three reviewers' one shared finding). Past
 * the deadline the form shows the retry; a late answer is dropped by the
 * form's sequence guard.
 */
export const ELEMENTS_SYNC_TIMEOUT_MS = 10_000;

export const ELEMENTS_SYNC_FAILED_MESSAGE =
  "Couldn't refresh the payment form with your new total. Try again, or go Back and continue to reload it.";

export async function syncElementsAmount(
  elements: ElementsLike,
  timeoutMs: number = ELEMENTS_SYNC_TIMEOUT_MS
): Promise<ElementsSyncOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ElementsSyncOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, message: `fetchUpdates timed out after ${timeoutMs}ms` }),
      timeoutMs
    );
  });
  const attempt = (async (): Promise<ElementsSyncOutcome> => {
    try {
      const result = await elements.fetchUpdates();
      if (result?.error) {
        return { ok: false, message: result.error.message || "fetchUpdates returned an error" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  })();
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
