/**
 * The money a My Reservations card shows (plan notes/2026-10-12-cost-breakdown-plan.md §4).
 *
 * The card has NO Stripe anchor — it reads only the booking row — so it must
 * never claim what the card was charged (a price moved after authorization, a
 * `due_at_location` ResLab omitted at creation, a derived discount would each
 * make a row-derived "paid" figure contradict the confirmation page, which is
 * anchored to the PaymentIntent and is the ONLY place that states the charge).
 * It shows the whole booking instead:
 *
 *   Booking total = grand_total + triply_service_fee + protection premium − discount_amount
 *
 * summed in integer cents, plus "Due at location" (ResLab's pay-at-lot share,
 * INSIDE grand_total) and, for a direct lot, the oversized-vehicle estimate
 * paid at the lot (OUTSIDE it) as sub-lines.
 *
 * Any unreadable input → `bookingTotalCents: null` and the card shows NO amount:
 * a missing number is never shown as $0.00, and a wrong one is worse than none.
 *
 * A cancelled / refunded booking shows no amount either: the original total
 * would contradict the refund the confirmation page shows (a self-cancel keeps
 * only the Park Guard wholesale), and the status badge already says cancelled.
 *
 * Pure and dependency-free (no "use client"): the card renders it and
 * `/api/user/bookings` uses it server-side to report unreadable rows.
 */
import { fallbackDue, grandTotalProven, toCents, type MoneyInput } from "@/lib/booking/cost-breakdown";

export interface ReservationCardMoney {
  status: string;
  inventory_source?: string | null;
  grand_total: MoneyInput;
  triply_service_fee: MoneyInput;
  /** The Park Guard plan; its premium counts only when a plan is set (the reconcile rule). */
  protection_plan?: string | null;
  protection_plan_price: MoneyInput;
  /** NOT NULL DEFAULT 0 (migration 016). */
  discount_amount: MoneyInput;
  /** NOT NULL DEFAULT 0 (migration 006); 0 on a direct row. */
  due_at_location: MoneyInput;
  /** The parts the stored grand_total must add up to before it may bound a due amount. */
  subtotal?: MoneyInput;
  fees_total?: MoneyInput;
  tax_total?: MoneyInput;
  /** Direct lots: the oversized-vehicle estimate PAID AT THE LOT, in cents. NULL on ResLab rows. */
  vehicle_surcharge_cents?: number | null;
  vehicle_surcharge_tax_cents?: number | null;
}

export interface ReservationCardAmounts {
  /** The whole booking; null = cancelled/refunded or unreadable → show no amount. */
  bookingTotalCents: number | null;
  /**
   * A LIVE booking whose total cannot be computed — the card hides a number it
   * would otherwise show, so the API reports it. Never true when cancelled.
   */
  unreadable: boolean;
  /** ResLab pay-at-location share (0 = none, unreadable, or cancelled). */
  dueAtLocationCents: number;
  /** ResLab: the stored due figure is missing, unreadable or larger than the
   *  booking — show "the lot will confirm", never a figure or "nothing due". */
  dueUnconfirmed: boolean;
  /** Direct oversized-vehicle estimate paid at the lot (0 = none, unreadable, or cancelled). */
  atLotCents: number;
}

const isCancelled = (status: string) => status === "cancelled" || status === "refunded";

const nonNegativeInt = (v: number | null | undefined): number | null =>
  v === null || v === undefined ? 0 : Number.isSafeInteger(v) && v >= 0 ? v : null;

export function reservationCardAmounts(b: ReservationCardMoney): ReservationCardAmounts {
  const grand = toCents(b.grand_total);
  const fee = toCents(b.triply_service_fee);
  const discount = toCents(b.discount_amount);

  // A set plan must carry a positive premium (migration 011); without a plan
  // the premium is 0 whatever the price column says.
  let premium: number | null = 0;
  if (b.protection_plan) {
    const p = toCents(b.protection_plan_price);
    premium = p !== null && p > 0 ? p : null;
  }

  // A ResLab total is shown only when its stored parts prove it (Codex
  // confirmation pass: an inflated grand_total otherwise carried a rejected
  // due amount into "Booking total"). The row does not store ResLab's
  // long-stay discount, so such a row reads as unreadable — hidden, reported
  // once — rather than a figure that does not add up.
  const reslabParts = { subtotal: b.subtotal, fees: b.fees_total, longTermDiscount: 0, tax: b.tax_total };
  const grandOk = b.inventory_source === "direct" || grandTotalProven(b.grand_total, reslabParts);
  let computed: number | null = null;
  if (grandOk && grand !== null && fee !== null && discount !== null && premium !== null) {
    const total = grand + fee + premium - discount;
    computed = total >= 0 ? total : null;
  }

  // Cancelled: no amount (it would contradict the refund) and nothing still
  // owed at the lot.
  const cancelled = isCancelled(b.status);
  const bookingTotalCents = cancelled ? null : computed;
  const unreadable = !cancelled && computed === null;

  // The same rule the confirmation page and the emails use (round-4 review):
  // a stored due larger than the booking is never shown as payable.
  let dueAtLocationCents = 0;
  let dueUnconfirmed = false;
  if (b.inventory_source !== "direct") {
    const d = fallbackDue({
      source: "reslab",
      recordedDue: b.due_at_location,
      grandTotal: b.grand_total,
      // The row does not store ResLab's long-stay discount: such a row cannot
      // prove its total, so a positive due on it reads "the lot confirms".
      parts: reslabParts,
      refusal: null,
      cancelled,
    });
    if (d.kind === "amount") dueAtLocationCents = d.cents;
    dueUnconfirmed = d.kind === "unconfirmed";
  }

  let atLotCents = 0;
  if (b.inventory_source === "direct" && !cancelled) {
    const s = nonNegativeInt(b.vehicle_surcharge_cents);
    const t = nonNegativeInt(b.vehicle_surcharge_tax_cents);
    // An unreadable estimate is hidden, never guessed.
    if (s !== null && t !== null) atLotCents = s + t;
  }

  return { bookingTotalCents, unreadable, dueAtLocationCents, dueUnconfirmed, atLotCents };
}
