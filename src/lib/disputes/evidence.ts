import type Stripe from "stripe";
import { termsTextFor } from "@/lib/checkout/terms-acceptance";

/**
 * Dispute evidence + playbook, built from the booking row, the checkout
 * contact, and the charge as Stripe records it.
 *
 * The webhook saves this to Stripe as a DRAFT (`submit: false`) — never
 * submitted automatically. A person reads it in the Stripe dashboard, adds what
 * only they can get (lot check-in proof, customer emails), and submits. Stripe
 * allows ONE submission per dispute, so a weak auto-submit would forfeit it.
 */

export const DISPUTE_BOOKING_SELECT =
  "id, reslab_reservation_number, location_name, location_address, airport_code, check_in, check_out, due_at_location, status, created_at, cancellation_reason, cancelled_by, cancel_state, cancel_claimed_at, inventory_source, customers(email, first_name, last_name)";

export type DisputeBooking = {
  id: string;
  reslab_reservation_number: string | null;
  location_name: string | null;
  location_address: string | null;
  airport_code: string | null;
  check_in: string | null;
  check_out: string | null;
  /** ResLab: the part of ResLab's total paid at the lot, never charged by us. Direct: always 0. */
  due_at_location: number | string | null;
  status: string | null;
  created_at: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  /** Migration 017. Non-null = a cancellation was started (it may be held or
   *  waiting on its refund while `status` still reads `confirmed`). */
  cancel_state: string | null;
  cancel_claimed_at: string | null;
  inventory_source: string | null;
  customers: { email: string | null; first_name: string | null; last_name: string | null } | null;
};

/**
 * Who the reservation is for. `checkout` = what the customer typed at checkout
 * (`pending_bookings.customer`). `account` = the linked customers row, which
 * can belong to a signed-in user who booked for someone else, so it is only
 * ever stated with that label.
 */
export type DisputeContact = { name: string | null; email: string | null; source: "checkout" | "account" };

/**
 * The disputed charge as Stripe records it. `bookings.grand_total` is not the
 * card amount: it leaves out the service fee, Park Guard and promos, and for
 * ResLab includes the part paid at the lot. null = Stripe couldn't be read, so
 * the draft states no amount, no refund status, no terms and no card checks.
 */
export type ChargeFacts = {
  capturedCents: number;
  refundedCents: number;
  currency: string;
  /** The checkbox wording agreed to (PaymentIntent `termsVersion`); null for
   *  charges made before versioning, which quote nothing. */
  termsText: string | null;
  chargedAtISO: string | null;
  cvcCheck: string | null;
  postalCheck: string | null;
  threeDSecure: string | null;
};

/** ChargeFacts from a dispute retrieved with `expand: ["charge", "payment_intent"]`. */
export function chargeFactsFrom(charge: Stripe.Charge, pi: Stripe.PaymentIntent | string | null): ChargeFacts {
  const card = charge.payment_method_details?.card;
  return {
    capturedCents: charge.amount_captured,
    refundedCents: charge.amount_refunded,
    currency: charge.currency,
    // The terms version lives on the PaymentIntent; Stripe doesn't copy PI
    // metadata onto the charge.
    termsText: typeof pi === "object" && pi ? termsTextFor(pi.metadata?.termsVersion) : null,
    chargedAtISO: new Date(charge.created * 1000).toISOString(),
    cvcCheck: card?.checks?.cvc_check ?? null,
    postalCheck: card?.checks?.address_postal_code_check ?? null,
    threeDSecure: card?.three_d_secure?.result ?? null,
  };
}

// Only checks Stripe actually ran and passed: "unavailable" / "unchecked" /
// "fail" are left out rather than dressed up as proof.
function cardCheckLines(c: ChargeFacts | null): string[] {
  if (!c) return [];
  const lines: string[] = [];
  if (c.cvcCheck === "pass") lines.push("Card security code (CVC) check: passed.");
  if (c.postalCheck === "pass") lines.push("Billing postal code check: passed.");
  if (c.threeDSecure === "authenticated") lines.push("3D Secure: the cardholder authenticated the payment.");
  else if (c.threeDSecure === "attempt_acknowledged") lines.push("3D Secure: authentication was attempted and acknowledged by the card issuer.");
  return lines;
}

// Booking times are airport-local literals: format the stored string, never
// run it through Date (CLAUDE.md anti-pattern).
const localTime = (s: string | null) => (s ? s.slice(0, 16).replace("T", " ") : "unknown");
const day = (s: string | null) => (s ? s.slice(0, 10) : undefined);
const money = (cents: number, currency: string) =>
  currency.toLowerCase() === "usd" ? `$${(cents / 100).toFixed(2)}` : `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

/**
 * Terms §5 as quoted below (self-cancel in My Reservations, 5-10 business day
 * refunds) went live on 2026-08-12, and §5.5 says the policy in force when the
 * reservation was made applies. Earlier bookings get no policy text: a person
 * writes it from the terms of the day.
 */
const POLICY_IN_FORCE_FROM = Date.parse("2026-08-13T00:00:00Z");
const policyApplies = (createdAt: string | null) => {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) && t >= POLICY_IN_FORCE_FROM;
};

const CANCELLATION_POLICY =
  "Triply Terms of Service, section 5 (https://www.triplypro.com/terms#cancellation), linked from the payment step at checkout: " +
  "an eligible reservation can be cancelled online through the customer's Triply account (My Reservations) more than 24 hours before the scheduled check-in time, " +
  "for a full refund of the amount paid online (except the non-refundable portion of any Park Guard protection plan). Reservations cannot be cancelled online within 24 hours of check-in; " +
  "late cancellations are handled case by case, and no-shows are not refunded.";

// Quoted from Terms §5.2 / §5.4, not from checkout: the checkout's own
// "partly non-refundable" wording only arrived 2026-10-13, after the policy
// gate date.
const REFUND_POLICY =
  "Triply Terms of Service, sections 5.2 and 5.4: approved refunds are issued to the original payment method and, depending on the bank or card issuer, typically appear within 5-10 business days. " +
  "A portion of any Park Guard protection plan price is non-refundable.";

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
          "Confirm in ResLab (or with the lot) that the reservation was not cancelled there — a lot-side cancel never reaches our booking record, and the draft's 'no cancellation' line only covers Triply's record",
          "Check Stripe for a refund already issued — if one exists, attach it and say so",
          "If they cancelled inside 24 hours or no-showed, show the cancel time vs check-in",
        ],
      };
    case "subscription_canceled":
      return {
        label: "Customer says they cancelled",
        addByHand: [
          "Confirm in ResLab (or with the lot) that the reservation was not cancelled there — a lot-side cancel never reaches our booking record, and the draft's 'no cancellation' line only covers Triply's record",
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

/**
 * Text evidence for Stripe. Every sentence states only what the booking row,
 * the checkout record or Stripe's charge records — a claim we can't back would
 * be read by the card issuer, and there is no second submission. Anything
 * unknown is left out for a person to write.
 */
export function buildEvidence(
  booking: DisputeBooking,
  reason: string,
  facts: { contact: DisputeContact | null; charge: ChargeFacts | null }
): Stripe.DisputeUpdateParams.Evidence {
  const { contact, charge } = facts;
  const conf = booking.reslab_reservation_number ?? booking.id;
  const lot = [booking.location_name, booking.location_address].filter(Boolean).join(", ");
  const atLotCents = Math.round(Number(booking.due_at_location ?? 0) * 100);
  const currency = charge?.currency ?? "usd";
  const withPolicy = policyApplies(booking.created_at);
  // `status` is the booking's status from BEFORE the dispute (the caller
  // passes the ledger's snapshot); null means it is unknown.
  const status = booking.status && booking.status !== "disputed" ? booking.status : null;
  // "No cancellation, no refund" needs all of: a live status (`refunded` and
  // `payment_failed` are not), nobody recorded as cancelling (`cancelled_by`
  // is best-effort and NULL on every cancel before 2026-09-30), no cancel
  // started (a held or refund-pending cancel keeps `confirmed`), and Stripe
  // showing nothing refunded (a partial refund leaves the status `confirmed`).
  const notCancelled =
    (status === "confirmed" || status === "completed") &&
    booking.cancelled_by == null &&
    booking.cancel_state == null &&
    booking.cancel_claimed_at == null &&
    charge != null &&
    charge.refundedCents === 0;

  const contactLine = !contact
    ? "Customer name and email: not recorded."
    : contact.source === "checkout"
      ? `Name and email entered at checkout: ${contact.name ?? "name not recorded"}, ${contact.email ?? "email not recorded"}.`
      : `Triply account linked to the reservation: ${contact.name ?? "name not recorded"}, ${contact.email ?? "email not recorded"}.`;

  const summary = [
    `Airport parking reservation ${conf}, booked on triplypro.com on ${localTime(booking.created_at)} UTC.`,
    contactLine,
    `Facility: ${lot || "see booking"}${booking.airport_code ? ` (${booking.airport_code} airport)` : ""}.`,
    `Reserved stay: check-in ${localTime(booking.check_in)} to check-out ${localTime(booking.check_out)}, airport local time.`,
    charge ? `Charged online by Triply: ${money(charge.capturedCents, currency)}.` : null,
    charge && charge.refundedCents > 0 ? `Refunded to the card so far: ${money(charge.refundedCents, currency)}.` : null,
    // No figure: ResLab prices some lots in CAD (the charge currency would
    // mislabel it), and only the online charge is in dispute.
    atLotCents > 0 ? "Part of the reservation price was payable directly at the facility; Triply did not charge it." : null,
    `Reservation status before the dispute: ${status ?? "not recorded"}${booking.cancelled_by ? ` (cancelled by ${booking.cancelled_by}${booking.cancellation_reason ? `, reason: ${booking.cancellation_reason}` : ""})` : ""}.`,
    ...cardCheckLines(charge),
  ]
    .filter(Boolean)
    .join("\n");

  // Pay stays disabled until the checkbox is ticked (wallets included — they
  // go through the same Pay button), and every PaymentIntent carries the
  // version of its wording, so a versioned charge proves the exact words
  // agreed to. Unversioned (older) charges quote nothing.
  const agreed = charge?.termsText
    ? `Before paying, the customer ticked a required checkbox reading: "${charge.termsText}"` +
      (charge.chargedAtISO ? ` (payment made ${charge.chargedAtISO.slice(0, 16).replace("T", " ")} UTC).` : "")
    : null;
  const cancellationDisclosure = [withPolicy ? CANCELLATION_POLICY : null, agreed].filter(Boolean).join(" ");

  // Only the checkout contact goes in the structured fields the issuer
  // matches against the cardholder; an account contact stays a labelled line.
  const typed = contact?.source === "checkout" ? contact : null;
  const evidence: Stripe.DisputeUpdateParams.Evidence = {
    customer_name: typed?.name ?? undefined,
    customer_email_address: typed?.email ?? undefined,
    product_description:
      `Airport parking reservation at ${lot || "a parking facility"}, booked and paid for online at triplypro.com` +
      `${atLotCents > 0 ? ", with part of the price payable at the facility" : ""}. ` +
      "Triply is the booking agent for the facility.",
    service_date: day(booking.check_in),
    cancellation_policy_disclosure: cancellationDisclosure || undefined,
    refund_policy_disclosure: withPolicy ? REFUND_POLICY : undefined,
    uncategorized_text: summary,
  };

  // Facts only, each scoped to its source. "Triply's booking record": a lot-
  // or ResLab-side cancel never reaches it, so the playbook makes the person
  // confirm in ResLab before submitting. No policy paraphrase (the policy has
  // its own field, quoted from Terms §5), and no general claims about how
  // reservations work — a top-up invoice is a second charge for one
  // reservation; a guest booking has no My Reservations.
  const noCancelOnRecord = "Triply's booking record for this reservation shows no cancellation";
  switch (reason) {
    case "credit_not_processed":
      if (notCancelled) {
        evidence.refund_refusal_explanation = `${noCancelOnRecord}, and Stripe shows no refund on this charge.`;
      }
      break;
    case "subscription_canceled":
      if (notCancelled) evidence.cancellation_rebuttal = `${noCancelOnRecord}.`;
      break;
    case "duplicate":
      evidence.duplicate_charge_explanation = `This charge is for reservation ${conf}.`;
      break;
  }

  return evidence;
}
