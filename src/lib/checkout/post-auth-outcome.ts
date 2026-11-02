/**
 * What the checkout page does with the answer to POST /api/reservations once
 * the customer's card is ALREADY authorized.
 *
 * Pure, so it is unit-tested without a component harness. The rule it encodes:
 *
 *   The card is held. The only answers that justify keeping the customer on
 *   the checkout page with an error are the ones in which the engine has
 *   definitively RELEASED that hold — 402 (payment never completed) and 409
 *   (sold out / duplicate / refunded / definitive failure) — and only when
 *   they carry the engine's own JSON message. Every other non-success answer —
 *   our own 502 `needsSupport`, a generic 500, a gateway 502/504 (or a
 *   platform 402/409) that returns an HTML page instead of JSON, a dropped
 *   connection, a 400 for a body the server could not read — leaves the
 *   booking in flight server-side (the staged row + the Stripe webhook finish
 *   it), so the customer is handed to /checkout/complete, which polls the
 *   engine for the truth. Before this rule those answers rendered a red
 *   "Payment Error" over a held card with Pay Now live again (launch-QA
 *   finding #8, Oct 28 2026).
 */

export type PostAuthAction =
  /** The reservation exists. Go to its confirmation page. */
  | { kind: "confirmed"; reservationNumber: string }
  /** The booking is in flight or its state is unknown. Hand off to /checkout/complete. */
  | { kind: "handoff"; reason: string }
  /** The engine released the hold. Stay on checkout and show the message. */
  | { kind: "stay"; message: string };

export interface ReservationAnswer {
  /** HTTP status; 0 when the request never got an answer (network failure). */
  status: number;
  /** Parsed JSON body, or null when there was none / it did not parse. */
  body: unknown;
}

function errorMessageOf(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return null;
}

function reservationNumberOf(body: unknown): string | null {
  if (body && typeof body === "object" && "reservation" in body) {
    const reservation = (body as { reservation: unknown }).reservation;
    if (reservation && typeof reservation === "object" && "reservationNumber" in reservation) {
      const n = (reservation as { reservationNumber: unknown }).reservationNumber;
      if (typeof n === "string" && n.trim()) return n;
    }
  }
  return null;
}

export function postAuthActionFor(answer: ReservationAnswer): PostAuthAction {
  const { status, body } = answer;

  if (status === 200) {
    const reservationNumber = reservationNumberOf(body);
    // A 200 without a usable reservation number is a contract drift, not a
    // failure: the booking was made. The complete page re-reads it by the
    // PaymentIntent (`already_exists`) and lands on the confirmation.
    return reservationNumber
      ? { kind: "confirmed", reservationNumber }
      : { kind: "handoff", reason: "success_without_reservation_number" };
  }

  if (status === 202) return { kind: "handoff", reason: "pending" };

  // The engine has released the hold: say why and let the customer act. Only
  // OUR route's answer carries the message — a platform 402/409 (an HTML
  // page, no JSON) says nothing about the hold, so it is a hand-off like any
  // other gateway answer.
  if (status === 402 || status === 409) {
    const message = errorMessageOf(body);
    if (message) return { kind: "stay", message };
    return { kind: "handoff", reason: `non_json_${status}` };
  }

  if (status === 0) return { kind: "handoff", reason: "network" };
  if (body === null) return { kind: "handoff", reason: `non_json_${status}` };
  return { kind: "handoff", reason: `http_${status}` };
}
