import type Stripe from "stripe";

/**
 * Dispute evidence + playbook, built from the booking row alone.
 *
 * The webhook saves this to Stripe as a DRAFT (`submit: false`) — never
 * submitted automatically. A person reads it in the Stripe dashboard, adds what
 * only they can get (lot check-in proof, customer emails), and submits. Stripe
 * allows ONE submission per dispute, so a weak auto-submit would forfeit it.
 */

export const DISPUTE_BOOKING_SELECT =
  "id, reslab_reservation_number, location_name, location_address, airport_code, check_in, check_out, grand_total, status, created_at, cancellation_reason, cancelled_by, inventory_source, customers(email, first_name, last_name)";

export type DisputeBooking = {
  id: string;
  reslab_reservation_number: string | null;
  location_name: string | null;
  location_address: string | null;
  airport_code: string | null;
  check_in: string | null;
  check_out: string | null;
  grand_total: number | string | null;
  status: string | null;
  created_at: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  inventory_source: string | null;
  customers: { email: string | null; first_name: string | null; last_name: string | null } | null;
};

// Booking times are airport-local literals: format the stored string, never
// run it through Date (CLAUDE.md anti-pattern).
const localTime = (s: string | null) => (s ? s.slice(0, 16).replace("T", " ") : "unknown");
const day = (s: string | null) => (s ? s.slice(0, 10) : undefined);

const CANCELLATION_POLICY =
  "Triply Terms of Service, section 5 (https://www.triplypro.com/terms#cancellation), linked from the payment step at checkout: " +
  "reservations can be cancelled online in My Reservations more than 24 hours before the scheduled check-in time, " +
  "for a full refund of the amount paid online (except the non-refundable portion of any Park Guard protection plan). Reservations cannot be cancelled online within 24 hours of check-in; " +
  "late cancellations are handled case by case, and no-shows are not refunded.";

const REFUND_POLICY =
  "Approved refunds go to the original payment method and appear within 5-10 business days. " +
  "A portion of any Park Guard protection plan is non-refundable, as disclosed at checkout.";

export type Playbook = {
  label: string;
  /** What a person must add by hand before submitting. */
  addByHand: string[];
};

/** Per-reason response plan. Keys are Stripe's `dispute.reason` values. */
export function playbookFor(reason: string): Playbook {
  switch (reason) {
    case "fraudulent":
      return {
        label: "Customer says they didn't make the booking",
        addByHand: [
          "Ask the lot whether the car was parked (entry/exit log, plate) and attach it",
          "Attach the booking confirmation email (Resend → Emails, search the customer's address)",
          "Any email or call from the customer about this booking",
          "If the customer has booked with us before, note the earlier reservation numbers",
        ],
      };
    case "product_not_received":
      return {
        label: "Customer says they didn't get the parking",
        addByHand: [
          "Proof from the lot the reservation was honored (check-in scan, gate log, receipt)",
          "Attach the booking confirmation email with the address and instructions",
          "If the lot turned them away, refund instead of fighting — it can't be won",
        ],
      };
    case "product_unacceptable":
      return {
        label: "Customer says the parking wasn't as described",
        addByHand: [
          "Screenshot of the lot listing as booked (amenities, shuttle, address)",
          "Any complaint thread with the customer and what we offered",
        ],
      };
    case "credit_not_processed":
      return {
        label: "Customer says a refund was promised but not paid",
        addByHand: [
          "Check Stripe for a refund already issued — if one exists, attach it and say so",
          "If they cancelled inside 24 hours or no-showed, show the cancel time vs check-in",
        ],
      };
    case "subscription_canceled":
      return {
        label: "Customer says they cancelled",
        addByHand: [
          "Show whether a cancellation exists in admin; if none, say so plainly",
          "If they cancelled in time and weren't refunded, refund instead of fighting",
        ],
      };
    case "duplicate":
      return {
        label: "Customer says they were charged twice",
        addByHand: [
          "Find the other charge; if both are for one reservation, refund one instead of fighting",
          "If they are two reservations, attach both confirmation numbers",
        ],
      };
    default:
      return {
        label: `Other (${reason})`,
        addByHand: [
          "Read the issuer's note in Stripe and answer that point directly",
          "Proof from the lot the reservation was honored",
        ],
      };
  }
}

/** Text evidence for Stripe, from what the booking row already proves. */
export function buildEvidence(
  booking: DisputeBooking,
  reason: string
): Stripe.DisputeUpdateParams.Evidence {
  const c = booking.customers;
  const name = [c?.first_name, c?.last_name].filter(Boolean).join(" ") || undefined;
  const conf = booking.reslab_reservation_number ?? booking.id;
  const lot = [booking.location_name, booking.location_address].filter(Boolean).join(", ");
  const total = booking.grand_total != null ? `$${Number(booking.grand_total).toFixed(2)}` : "the amount charged";
  // `status` is the booking's status from BEFORE the dispute (the caller
  // passes the ledger's snapshot); null means it is unknown. Every sentence
  // below states only what the row records. A claim we can't back would be
  // read by the card issuer, and there is no second submission.
  const status = booking.status && booking.status !== "disputed" ? booking.status : null;
  const cancelled = status === "cancelled" || booking.cancelled_by != null;
  const notCancelled = status != null && !cancelled;

  const summary = [
    `Airport parking reservation ${conf}, booked on triplypro.com on ${localTime(booking.created_at)} UTC.`,
    `Name on the reservation: ${name ?? "not recorded"}. Email on the reservation: ${c?.email ?? "not recorded"}.`,
    `Facility: ${lot || "see booking"}${booking.airport_code ? ` (${booking.airport_code} airport)` : ""}.`,
    `Reserved stay: check-in ${localTime(booking.check_in)} to check-out ${localTime(booking.check_out)}, airport local time.`,
    `Charged ${total}.`,
    `Reservation status before the dispute: ${status ?? "not recorded"}${booking.cancelled_by ? ` (cancelled by ${booking.cancelled_by}${booking.cancellation_reason ? `, reason: ${booking.cancellation_reason}` : ""})` : ""}.`,
  ].join("\n");

  const evidence: Stripe.DisputeUpdateParams.Evidence = {
    customer_name: name,
    customer_email_address: c?.email ?? undefined,
    product_description:
      `Prepaid airport parking reservation at ${lot || "a parking facility"}. ` +
      "Triply is the booking agent for the facility.",
    service_date: day(booking.check_in),
    cancellation_policy_disclosure: CANCELLATION_POLICY,
    refund_policy_disclosure: REFUND_POLICY,
    uncategorized_text: summary,
  };

  // Only rebut a cancellation claim when the pre-dispute status is known and
  // shows no cancel. Otherwise leave the field empty for a person to write.
  switch (reason) {
    case "credit_not_processed":
      if (notCancelled) {
        evidence.refund_refusal_explanation =
          "Our records show no cancellation of this reservation, so no refund was due under the cancellation policy.";
      }
      break;
    case "subscription_canceled":
      if (notCancelled) {
        evidence.cancellation_rebuttal =
          "Our records show no cancellation of this reservation. Cancellation is self-service in My Reservations up to 24 hours before check-in.";
      }
      break;
    case "duplicate":
      evidence.duplicate_charge_explanation =
        `This charge is for reservation ${conf} only. Each reservation is a separate charge with its own confirmation number.`;
      break;
  }

  return evidence;
}
