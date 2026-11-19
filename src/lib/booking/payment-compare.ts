/**
 * REPORT-ONLY comparison of a ResLab booking with its PaymentIntent's own
 * record. Nothing here decides anything.
 *
 * The four functions the engine calls (compareRequestWithPayment,
 * noteUnstagedPayment, comparePriceCheck, compareReservationWithPayment)
 * return void, have no `await`, make no network or database call, write to
 * none of their arguments and keep no module state; their only side effect is
 * one queued Sentry event. Each wraps its whole body in try/catch, and the
 * engine wraps each call in its own as well, so a fault here can never reach
 * a booking.
 *
 * Reports carry field NAMES, lot and parking-type ids, cents and the
 * PaymentIntent id. Never an email, a name, a phone number, a plate or a token.
 */
import { capturePaymentCompare, type PaymentCompareOutcome, type PaymentCompareSite } from "@/lib/sentry";
import { readServiceFeeCents, readStampedDiscount } from "@/lib/promo/stamped-discount";
import { reslabAmountCents } from "@/lib/fx/cad-usd";
import { toPricingWindow } from "@/lib/reslab/pricing-window";

type Metadata = Readonly<Record<string, string | undefined>> | null | undefined;

interface PaymentIntentLike {
  readonly id: string;
  readonly amount: number;
  readonly livemode: boolean;
  readonly metadata?: Metadata;
}

/** The part of a booking payload this file reads. */
interface PayloadLike {
  readonly locationId: number;
  readonly parkingTypeId: number;
  readonly fromDate: string;
  readonly toDate: string;
  readonly customer: { readonly email: string };
  readonly triplyServiceFee?: number;
}

/** The part of a staged row this file reads. */
interface StagedRowLike {
  readonly location_id: number | null;
  readonly parking_type_id: number | null;
  readonly from_date: string;
  readonly to_date: string;
  readonly customer: { readonly email?: unknown } | null;
  readonly triply_service_fee?: string | number | null;
  readonly reslab_reservation_number?: string | null;
}

const ID_RE = /^[1-9]\d{0,9}$/;
const WINDOW_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** A time as the pickers write it ("9:30 AM", "12:00 PM"); a leading zero prices the same. */
const TIME_RE = /^(0?[1-9]|1[0-2]):[0-5]\d (AM|PM)$/;
/** A stored dollar amount: "5.95", "6.00", "6". */
const STORED_DOLLARS_RE = /^(0|[1-9]\d{0,6})(\.\d{1,2})?$/;
const BOUND_KEYS = ["locationId", "parkingTypeId", "checkin", "checkout", "checkinTime", "checkoutTime", "customerEmail"] as const;

type BoundKey = (typeof BOUND_KEYS)[number];
export type BookedField = "lot" | "parkingType" | "from" | "to" | "email";

export type PaymentBound =
  | { ok: true; locationId: number; parkingTypeId: number; fromDate: string; toDate: string; email: string }
  | { ok: false; unusable: BoundKey[] };

const normalEmail = (email: string): string => email.trim().toLowerCase();

/**
 * What the PaymentIntent records: lot, parking type, the exact window (the
 * same `date + 24-hour time` expression checkout prices with) and the email.
 * `unusable` names every key that is missing or will not read.
 */
export function boundFromPayment(metadata: Metadata): PaymentBound {
  const m = metadata ?? {};
  const unusable: BoundKey[] = BOUND_KEYS.filter((key) => m[key] === undefined || m[key] === "");
  const { locationId, parkingTypeId, checkin, checkout, checkinTime, checkoutTime, customerEmail } = m;
  if (locationId && !ID_RE.test(locationId)) unusable.push("locationId");
  if (parkingTypeId && !ID_RE.test(parkingTypeId)) unusable.push("parkingTypeId");
  if (!checkin || !checkout || !checkinTime || !checkoutTime || !locationId || !parkingTypeId || !customerEmail || unusable.length > 0) {
    return { ok: false, unusable };
  }
  // convertTo24Hour neither throws on a malformed time nor refuses "10:00" or
  // "25:99 XM", so the times are checked first.
  if (!TIME_RE.test(checkinTime)) unusable.push("checkinTime");
  if (!TIME_RE.test(checkoutTime)) unusable.push("checkoutTime");
  if (unusable.length > 0) return { ok: false, unusable };
  const window = toPricingWindow(checkin, checkout, { checkinTime, checkoutTime });
  // With the times good, a window of the wrong shape means a malformed date.
  if (!WINDOW_RE.test(window.fromDate)) unusable.push("checkin");
  if (!WINDOW_RE.test(window.toDate)) unusable.push("checkout");
  if (unusable.length > 0) return { ok: false, unusable };
  return {
    ok: true,
    locationId: Number(locationId),
    parkingTypeId: Number(parkingTypeId),
    fromDate: window.fromDate,
    toDate: window.toDate,
    email: normalEmail(customerEmail),
  };
}

/** The fields where a booking payload differs from the payment's record. */
export function fieldsDifferingFromPayment(used: PayloadLike, bound: Extract<PaymentBound, { ok: true }>): BookedField[] {
  const fields: BookedField[] = [];
  if (used.locationId !== bound.locationId) fields.push("lot");
  if (used.parkingTypeId !== bound.parkingTypeId) fields.push("parkingType");
  if (used.fromDate !== bound.fromDate) fields.push("from");
  if (used.toDate !== bound.toDate) fields.push("to");
  if (normalEmail(used.customer.email) !== bound.email) fields.push("email");
  return fields;
}

/** The fields where a request body differs from its staged row. */
export function fieldsDifferingFromRow(request: PayloadLike, row: StagedRowLike): BookedField[] {
  const fields: BookedField[] = [];
  if (request.locationId !== row.location_id) fields.push("lot");
  if (request.parkingTypeId !== row.parking_type_id) fields.push("parkingType");
  if (request.fromDate !== row.from_date) fields.push("from");
  if (request.toDate !== row.to_date) fields.push("to");
  const rowEmail = row.customer?.email;
  if (typeof rowEmail !== "string" || normalEmail(request.customer.email) !== normalEmail(rowEmail)) fields.push("email");
  return fields;
}

/** A dollar figure as a request (number) or a staged row (number or numeric string) holds it, in whole cents; null when absent or unreadable. */
function dollarsToCents(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  return typeof value === "string" && STORED_DOLLARS_RE.test(value) ? Math.round(Number(value) * 100) : null;
}

/** A fault inside a comparison: the site and the error's class only, never its message. */
function reportCrash(site: PaymentCompareSite, pi: PaymentIntentLike | null | undefined, error: unknown): void {
  try {
    capturePaymentCompare(site, "crashed", {
      stripePaymentIntentId: typeof pi?.id === "string" ? pi.id : "unknown",
      livemode: pi?.livemode === true,
      detail: { errorClass: error instanceof Error ? error.constructor.name : typeof error },
    });
  } catch {
    // Deliberately not rethrown: this file must never throw into the booking
    // engine. The site name alone goes to the function log, so a reporter
    // that is down is not mistaken for "nothing to report".
    console.error("payment-compare: reporter failed", site);
  }
}

/**
 * Site 1: the booking payload against the payment's record, once per
 * fulfilment attempt. `used` is the payload the engine holds; `request` is the
 * browser's body when this call carried one. The fee compared is the one that
 * CAME IN (the request's, else the staged row's), not `used`'s: on a payment
 * with a discount stamp the engine has already set `used`'s fee from the
 * payment. Outcome, first that applies: the record is unusable; a booked field
 * differs; the request differs from its row; the fee differs; the fee is
 * unknown; match.
 */
export function compareRequestWithPayment(
  pi: PaymentIntentLike,
  row: StagedRowLike,
  used: PayloadLike,
  request: PayloadLike | undefined
): void {
  try {
    const tags: Record<string, string> = {
      "check.payload_source": request ? "request" : "row",
      // A retried or resumed fulfilment reports again: count PaymentIntents, not events.
      "check.attempt": row.reslab_reservation_number ? "resume" : "first",
      "check.discount_stamp": readStampedDiscount(pi.metadata).kind === "absent" ? "no" : "yes",
    };
    const detail: Record<string, string | number | readonly string[]> = {};

    const rowFields = request ? fieldsDifferingFromRow(request, row) : [];
    if (request) tags["check.row_vs_request"] = rowFields.length > 0 ? "differs" : "same";
    if (rowFields.length > 0) detail.rowVsRequestFields = rowFields;

    const paymentFeeCents = readServiceFeeCents(pi.metadata);
    const incomingFeeCents = dollarsToCents(request ? request.triplyServiceFee : row.triply_service_fee);
    const feeResult = paymentFeeCents === null || incomingFeeCents === null ? "unknown" : paymentFeeCents === incomingFeeCents ? "same" : "differs";
    tags["check.fee"] = feeResult;
    if (paymentFeeCents !== null && incomingFeeCents !== null && feeResult === "differs") {
      detail.incomingFeeCents = incomingFeeCents;
      detail.paymentFeeCents = paymentFeeCents;
    }

    const bound = boundFromPayment(pi.metadata);
    if (!bound.ok) {
      capturePaymentCompare("request", "payment_record_unusable", {
        stripePaymentIntentId: pi.id,
        livemode: pi.livemode,
        tags,
        detail: { ...detail, unusableKeys: bound.unusable },
      });
      return;
    }
    const fields = fieldsDifferingFromPayment(used, bound);
    if (fields.length > 0) Object.assign(detail, { fields, paymentLot: bound.locationId, usedLot: used.locationId });
    const outcome: PaymentCompareOutcome["request"] =
      fields.length > 0
        ? "differs"
        : rowFields.length > 0
          ? "row_differs"
          : feeResult === "differs"
            ? "fee_differs"
            : feeResult === "unknown"
              ? "fee_unknown"
              : "match";
    capturePaymentCompare("request", outcome, { stripePaymentIntentId: pi.id, livemode: pi.livemode, tags, detail });
  } catch (error) {
    reportCrash("request", pi, error);
  }
}

/** Site 2: a payment that reached fulfilment with no staged row. */
export function noteUnstagedPayment(pi: PaymentIntentLike): void {
  try {
    capturePaymentCompare("unstaged", "no_staged_row", {
      stripePaymentIntentId: pi.id,
      livemode: pi.livemode,
      tags: { "check.source_stamped": pi.metadata?.inventorySource === undefined ? "no" : "yes" },
    });
  } catch (error) {
    reportCrash("unstaged", pi, error);
  }
}

/**
 * Site 3: the pre-booking price check on a payment with no discount stamp,
 * worked a second time with the service fee the payment records. The engine's
 * own expression with only the fee term changed, so a one-cent rounding edge
 * is never put down to the fee. `freshCents` is the engine's figure.
 */
export function comparePriceCheck(
  pi: PaymentIntentLike,
  used: PayloadLike,
  cost: { readonly reservation: { readonly grand_total: number; readonly due_at_location: number } },
  promoDiscount: number,
  protectionPremium: number,
  freshCents: number
): void {
  try {
    const feeCents = readServiceFeeCents(pi.metadata);
    const tags: Record<string, string> = {
      "check.payload_fee": typeof used.triplyServiceFee === "number" ? "present" : "missing",
    };
    if (feeCents === null) {
      capturePaymentCompare("price_check", "fee_unreadable", { stripePaymentIntentId: pi.id, livemode: pi.livemode, tags });
      return;
    }
    const withPaymentFeeCents = Math.round(
      (cost.reservation.grand_total + feeCents / 100 - promoDiscount - cost.reservation.due_at_location + protectionPremium) * 100
    );
    if (!Number.isFinite(withPaymentFeeCents) || !Number.isFinite(freshCents)) {
      capturePaymentCompare("price_check", "unverified", { stripePaymentIntentId: pi.id, livemode: pi.livemode, tags });
      return;
    }
    const engineOver = freshCents > pi.amount + 1;
    const paymentFeeOver = withPaymentFeeCents > pi.amount + 1;
    capturePaymentCompare("price_check", engineOver === paymentFeeOver ? "match" : paymentFeeOver ? "payment_fee_over" : "payment_fee_within", {
      stripePaymentIntentId: pi.id,
      livemode: pi.livemode,
      tags,
      detail: { freshCents, withPaymentFeeCents, authorisedCents: pi.amount },
    });
  } catch (error) {
    reportCrash("price_check", pi, error);
  }
}

/** The discount a payment records, in cents: its stamp; 0 with no promo; null (unknown) for an unusable stamp or an unstamped percent. */
function recordedDiscountCents(metadata: Readonly<Record<string, string | undefined>>): number | null {
  const stamp = readStampedDiscount(metadata);
  if (stamp.kind === "cents") return stamp.cents;
  if (stamp.kind === "invalid") return null;
  const percent = metadata.discountPercent;
  return percent === undefined || percent === "" || percent === "0" ? 0 : null;
}

function differenceBucket(differenceCents: number | null): string {
  if (differenceCents === null) return "unknown";
  const size = Math.abs(differenceCents);
  return size === 0 ? "0" : size === 1 ? "1c" : size <= 100 ? "2_to_100c" : "over_100c";
}

/**
 * Site 4: the reservation just created, against the payment's record. Money in
 * whole cents: amount = grand − due at the lot + service fee − discount +
 * protection premium. A figure that is missing or will not read is unknown,
 * never 0, and an unknown is never a match.
 */
export function compareReservationWithPayment(
  pi: PaymentIntentLike,
  fr: {
    readonly money: { readonly grandTotal: unknown; readonly dueAtLocation: unknown };
    readonly location: { readonly reslabLocationId: unknown } | null;
    readonly dates: ReadonlyArray<{ readonly fromDate: unknown; readonly toDate: unknown }> | null;
  },
  charged: { readonly premium: number } | null
): void {
  try {
    const metadata = pi.metadata ?? {};
    const grand = reslabAmountCents(fr.money.grandTotal);
    const due = reslabAmountCents(fr.money.dueAtLocation);
    const fee = readServiceFeeCents(metadata);
    const discount = recordedDiscountCents(metadata);
    const premiumCents = Math.round((charged?.premium ?? 0) * 100);
    const premium = Number.isSafeInteger(premiumCents) && premiumCents >= 0 ? premiumCents : null;
    const differenceCents =
      grand === null || due === null || fee === null || discount === null || premium === null
        ? null
        : pi.amount - (grand - due + fee - discount + premium);
    const unknownFigures: string[] = [];
    if (grand === null) unknownFigures.push("grand");
    if (due === null) unknownFigures.push("due");
    if (fee === null) unknownFigures.push("fee");
    if (discount === null) unknownFigures.push("discount");
    if (premium === null) unknownFigures.push("premium");

    const bound = boundFromPayment(metadata);
    const lotRaw = fr.location?.reslabLocationId;
    const lot = typeof lotRaw === "number" ? lotRaw : typeof lotRaw === "string" && ID_RE.test(lotRaw) ? Number(lotRaw) : null;
    const lotResult = !bound.ok || lot === null ? "unknown" : lot === bound.locationId ? "match" : "mismatch";
    // The DAYS are compared. ResLab's reservation dates can come back as
    // midnight whatever time was booked, so the clock time is its own tag and
    // never part of the outcome.
    const first = fr.dates?.[0];
    const from = typeof first?.fromDate === "string" ? first.fromDate : null;
    const to = typeof first?.toDate === "string" ? first.toDate : null;
    const datesResult =
      !bound.ok || from === null || to === null
        ? "unknown"
        : from.slice(0, 10) === bound.fromDate.slice(0, 10) && to.slice(0, 10) === bound.toDate.slice(0, 10)
          ? "match"
          : "mismatch";
    const timesResult =
      !bound.ok || from === null || to === null
        ? "unknown"
        : from === bound.fromDate && to === bound.toDate
          ? "match"
          : from.endsWith(" 00:00:00") && to.endsWith(" 00:00:00")
            ? "midnight_only"
            : "mismatch";

    const bucket = differenceBucket(differenceCents);
    // Charged above the reservation's figures (its price fell after checkout) or below them.
    const direction = differenceCents === null ? "unknown" : differenceCents === 0 ? "exact" : differenceCents > 0 ? "charged_more" : "charged_less";
    const agrees = bucket === "0" && lotResult === "match" && datesResult === "match";
    capturePaymentCompare("reservation", agrees ? "match" : "differs", {
      stripePaymentIntentId: pi.id,
      livemode: pi.livemode,
      tags: {
        "check.amount": bucket,
        "check.amount_direction": direction,
        "check.lot": lotResult,
        "check.dates": datesResult,
        "check.times": timesResult,
      },
      detail: {
        differenceCents: differenceCents ?? "unknown",
        unknownFigures,
        ...(bound.ok ? {} : { unusableKeys: bound.unusable }),
      },
    });
  } catch (error) {
    reportCrash("reservation", pi, error);
  }
}
