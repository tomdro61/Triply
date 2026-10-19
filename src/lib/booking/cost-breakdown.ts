/**
 * The cost breakdown a customer sees after booking — confirmation page,
 * confirmation email, admin email (plan notes/2026-10-12-cost-breakdown-plan.md).
 *
 * ONE pure function does every sum, in integer cents, so no surface can add up
 * differently from another. Two shapes, because money moves differently:
 *
 *   ResLab  `due_at_location` is INSIDE ResLab's grand_total (and its subtotal
 *           and tax): lines → Total → Paid online / Due at location — the same
 *           order as the checkout summary.
 *   Direct  the oversized-vehicle surcharge is OUTSIDE the charge: lines →
 *           Charged to card → Due at the lot (est.) → Trip total (est.).
 *
 * THE ANCHOR. The card amount computed from the parts must equal what Stripe
 * actually charged (`pi.amount` at fulfilment; the PaymentIntent's
 * `amount_received` on the page) to the cent, and ResLab's own identity
 * (subtotal + fees − long-stay discount + tax = grand_total) must hold. A
 * check built only from its own parts would pass by construction; this one
 * fails when a price moved after authorization, dates were edited, a legacy
 * row lacks the fee, or a read failed. ANY failed rule or missing input →
 * `{ ok: false }` and the caller shows the plain fallback — never a breakdown
 * that does not add up, never a missing value shown as $0.00.
 */

/** A money value as it arrives: a number, or a Postgres DECIMAL string. */
export type MoneyInput = number | string | null | undefined;

/**
 * Dollars → integer cents, rounding half up on the DECIMAL digits (not on a
 * binary float: 1.005 is 101 cents, not 100). null for anything that is not a
 * plain non-negative decimal — the caller then falls back rather than show $0.
 */
export function toCents(value: MoneyInput): number | null {
  if (value === null || value === undefined) return null;
  // Vendor JSON is cast, not validated: a boolean or object must read as
  // unknown, never throw on the money path (round-3 review).
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(3, "0");
  const cents = Number(m[1]) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

export interface ProtectionInput {
  /** The plan as the customer chose it — "Plan A", "Plan B", "Plan C" (callers pass `Plan ${code}`). */
  name: string;
  premium: MoneyInput;
}

interface CommonInput {
  /** Billed days; null → the line reads "Parking". */
  days: number | null;
  serviceFee: MoneyInput;
  /** Promo discount taken off the card charge (0 = none). */
  promoDiscount: MoneyInput;
  promoCode: string | null;
  /**
   * The promo discount the code's PERCENT gives on its base, in cents, worked
   * out independently of the charge (e.g. round(base × pct / 100)). Required
   * whenever `promoDiscount` > 0: a discount derived as "what we would have
   * charged − what Stripe took" agrees with the anchor BY CONSTRUCTION, so a
   * price that moved after authorization — or a ResLab due-at-location amount
   * missing at creation — would otherwise be absorbed into the promo line.
   * null with a discount → fallback. Pass it whenever the PaymentIntent
   * carries a promo percent, EVEN IF no discount was recorded: a positive
   * expectation with a $0 recorded discount also falls back.
   */
  expectedPromoCents: number | null;
  protection: ProtectionInput | null;
  /** What Stripe charged, in cents (`pi.amount` / `amount_received`). null = unknown → fallback. */
  anchorChargedCents: number | null;
  /** Refunded to the card so far, in cents (0 = none). */
  refundedCents: number;
  cancelled: boolean;
}

export interface ReslabCostInput extends CommonInput {
  source: "reslab";
  subtotal: MoneyInput;
  fees: MoneyInput;
  longTermDiscount: MoneyInput;
  tax: MoneyInput;
  grandTotal: MoneyInput;
  dueAtLocation: MoneyInput;
  /** Page only: the grand_total stored on the booking row — must equal ResLab's live one. */
  storedGrandTotal?: MoneyInput;
}

export interface DirectCostInput extends CommonInput {
  source: "direct";
  subtotal: MoneyInput;
  tax: MoneyInput;
  /** The oversized-vehicle surcharge paid AT THE LOT; null = none. */
  atLot: { surchargeCents: number; surchargeTaxCents: number; vehicleSizeLabel: string } | null;
}

export type CostBreakdownInput = ReslabCostInput | DirectCostInput;

export interface CostLine {
  key: "parking" | "long_stay_discount" | "taxes" | "service_fee" | "promo" | "protection";
  label: string;
  /** Always positive; `credit` lines are subtracted. */
  cents: number;
  credit: boolean;
}

export interface CostBreakdown {
  ok: true;
  source: "reslab" | "direct";
  lines: CostLine[];
  /**
   * The line under the rule. ResLab with money due at the location: "Total"
   * (the whole booking). Otherwise the card charge.
   */
  totalLabel: "Total" | "Paid online (card)" | "Charged to card";
  totalCents: number;
  /** ResLab only, when something is due at the location: the card share of Total. */
  paidOnlineCents: number;
  /** ResLab pay-at-lot share (0 = none / cancelled). */
  dueAtLocationCents: number;
  /** Direct oversized-vehicle estimate (null = none / cancelled). */
  atLot: { cents: number; surchargeCents: number; surchargeTaxCents: number; vehicleSizeLabel: string } | null;
  /** Card charge + anything still due at the lot / location; null when nothing is. */
  tripTotalCents: number | null;
  /** True when the trip total includes an ESTIMATE (the direct at-lot surcharge). */
  tripTotalIsEstimate: boolean;
  refundedCents: number;
  /** Card charge − refunds; null when nothing was refunded. */
  netPaidCents: number | null;
  cancelled: boolean;
}

export type CostBreakdownResult = CostBreakdown | { ok: false; reason: string };

const fail = (reason: string): CostBreakdownResult => ({ ok: false, reason });

function parkingLabel(days: number | null): string {
  if (days === null || !Number.isInteger(days) || days < 1) return "Parking";
  return `Parking — ${days} ${days === 1 ? "day" : "days"}`;
}

export function buildCostBreakdown(input: CostBreakdownInput): CostBreakdownResult {
  if (input.anchorChargedCents === null || !Number.isSafeInteger(input.anchorChargedCents)) return fail("what the card was charged is unknown");
  if (!Number.isSafeInteger(input.refundedCents) || input.refundedCents < 0) return fail("refund amount unreadable");

  const subtotal = toCents(input.subtotal);
  const tax = toCents(input.tax);
  const serviceFee = toCents(input.serviceFee);
  const promo = toCents(input.promoDiscount);
  if (subtotal === null) return fail("subtotal missing");
  if (tax === null) return fail("tax missing");
  if (serviceFee === null) return fail("service fee missing (legacy row?)");
  if (promo === null) return fail("promo discount unreadable");
  // The promo is checked whenever EITHER side says there is one: a discount
  // recorded with nothing to check it against falls back, and so does a
  // percent the PaymentIntent carries with no (or a different) discount
  // recorded — a price that dropped after authorization can derive a $0
  // discount and silently drop the code from the receipt. ±1¢: the percent
  // base is itself a rounded sum on some paths.
  if (input.expectedPromoCents !== null && (!Number.isSafeInteger(input.expectedPromoCents) || input.expectedPromoCents < 0)) {
    return fail("promo percent unreadable");
  }
  const expectedPromo = input.expectedPromoCents ?? 0;
  if (promo > 0 && input.expectedPromoCents === null) return fail("promo discount cannot be checked against the code's percent");
  if (Math.abs(promo - expectedPromo) > 1) return fail("promo discount does not match the code's percent");
  let premium = 0;
  if (input.protection) {
    const p = toCents(input.protection.premium);
    if (p === null || p <= 0) return fail("protection plan without a valid premium");
    premium = p;
  }

  const lines: CostLine[] = [];
  const push = (key: CostLine["key"], label: string, cents: number, credit = false) => {
    if (cents > 0) lines.push({ key, label, cents, credit });
  };

  if (input.source === "reslab") {
    const fees = toCents(input.fees);
    const ltd = toCents(input.longTermDiscount ?? 0);
    const grand = toCents(input.grandTotal);
    // A MISSING due-at-location is not "nothing due": ResLab has omitted it at
    // creation before (RTL753241), and on a promo booking the derived discount
    // would swallow it — the customer told nothing is owed at the lot.
    const due = toCents(input.dueAtLocation);
    if (fees === null) return fail("fees missing");
    if (ltd === null) return fail("long-stay discount unreadable");
    if (grand === null) return fail("grand total missing");
    if (due === null) return fail("due at location unreadable");
    if (subtotal + fees - ltd + tax !== grand) return fail("ResLab parts do not add up to its grand total");
    if (input.storedGrandTotal !== undefined) {
      const stored = toCents(input.storedGrandTotal);
      if (stored === null || stored !== grand) return fail("ResLab's total no longer matches the booking (modified after booking?)");
    }
    const total = grand + serviceFee - promo + premium;
    const paidOnline = total - due;
    if (due > grand) return fail("due at location exceeds the parking total");
    if (paidOnline !== input.anchorChargedCents) return fail("the parts do not add up to what the card was charged");

    // Fees roll into the parking line, as the checkout summary shows them
    // (ResLab's total_fees includes its own channel fee — never "lot fees").
    push("parking", parkingLabel(input.days), subtotal + fees);
    push("long_stay_discount", "Long-stay discount", ltd, true);
    push("taxes", "Taxes", tax);
    push("service_fee", "Triply service fee", serviceFee);
    push("promo", input.promoCode ? `Promo discount (${input.promoCode})` : "Promo discount", promo, true);
    if (input.protection) push("protection", `Parking Protection — ${input.protection.name}`, premium);

    const showDue = due > 0;
    const dueNow = showDue && !input.cancelled ? due : 0;
    return {
      ok: true,
      source: "reslab",
      lines,
      totalLabel: showDue ? "Total" : "Paid online (card)",
      totalCents: total,
      paidOnlineCents: paidOnline,
      dueAtLocationCents: dueNow,
      atLot: null,
      tripTotalCents: null,
      tripTotalIsEstimate: false,
      refundedCents: input.refundedCents,
      netPaidCents: input.refundedCents > 0 ? paidOnline - input.refundedCents : null,
      cancelled: input.cancelled,
    };
  }

  // Direct: every line is part of the card charge; the at-lot surcharge is not.
  const charged = subtotal + tax + serviceFee - promo + premium;
  if (charged !== input.anchorChargedCents) return fail("the parts do not add up to what the card was charged");
  push("parking", parkingLabel(input.days), subtotal);
  push("taxes", "Taxes", tax);
  push("service_fee", "Triply service fee", serviceFee);
  push("promo", input.promoCode ? `Promo discount (${input.promoCode})` : "Promo discount", promo, true);
  if (input.protection) push("protection", `Parking Protection — ${input.protection.name}`, premium);

  let atLot: CostBreakdown["atLot"] = null;
  if (input.atLot && !input.cancelled) {
    const { surchargeCents, surchargeTaxCents, vehicleSizeLabel } = input.atLot;
    if (!Number.isSafeInteger(surchargeCents) || !Number.isSafeInteger(surchargeTaxCents) || surchargeCents < 0 || surchargeTaxCents < 0) {
      return fail("at-lot surcharge unreadable");
    }
    const cents = surchargeCents + surchargeTaxCents;
    if (cents > 0) atLot = { cents, surchargeCents, surchargeTaxCents, vehicleSizeLabel };
  }
  return {
    ok: true,
    source: "direct",
    lines,
    totalLabel: "Charged to card",
    totalCents: charged,
    paidOnlineCents: charged,
    dueAtLocationCents: 0,
    atLot,
    tripTotalCents: atLot ? charged + atLot.cents : null,
    tripTotalIsEstimate: atLot !== null,
    refundedCents: input.refundedCents,
    netPaidCents: input.refundedCents > 0 ? charged - input.refundedCents : null,
    cancelled: input.cancelled,
  };
}

/** "$1,234.56" / "−$5.00" — one formatter for every surface. */
export function formatUsd(cents: number, credit = false): string {
  const abs = Math.abs(cents);
  const text = `$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return credit || cents < 0 ? `−${text}` : text;
}


/**
 * What a FALLBACK (the breakdown was refused) may say about money due at the
 * lot / location — decided on the due figure's OWN merits, never from which
 * check happened to fail first (round-3 review: one reviewer reproduced a
 * $200 due on an $88 booking printed as fact; the other found a real due
 * amount hidden from the customer with nowhere else to see it).
 *
 *   amount       a positive figure that fits inside the booking: shown, "as
 *                recorded" — a real number is never worse than none.
 *   unconfirmed  the figure is missing, unreadable or larger than the
 *                booking, OR it is 0 and the breakdown was refused for any
 *                reason other than the card side being unreadable: never
 *                "nothing due" — "the lot will confirm any amount on
 *                arrival", with the support contact.
 *   none         nothing is due, and the breakdown either agreed or failed
 *                only because the card side could not be read.
 *
 * `refusal: null` means the breakdown AGREED (or the caller has no breakdown
 * and only bounds-checks a stored figure, as the My Reservations card does).
 *
 * Direct lots: the at-lot surcharge sits OUTSIDE the card charge and is never
 * checked against it, so only an unreadable surcharge withholds it.
 */
export type FallbackDue =
  | { kind: "amount"; cents: number }
  | { kind: "unconfirmed" }
  | { kind: "none" };

/**
 * Refusals that say NOTHING about the online / at-the-lot split — only that
 * the card side could not be read. Every OTHER refusal (including ones that
 * stop early, e.g. "subtotal missing") leaves a recorded $0 due unproven, so
 * it reads as "unconfirmed", never "nothing due" (round-4 review: a whitelist
 * of doubtful reasons missed the early exits).
 */
const CARD_SIDE_ONLY = ["what the card was charged is unknown"];

/** The ResLab parts that must add up to `grandTotal` before it may bound a due amount. */
export interface ReslabTotalParts {
  subtotal: MoneyInput;
  fees: MoneyInput;
  /** Absent on rows that do not store it (the My Reservations card) — pass 0 there. */
  longTermDiscount: MoneyInput;
  tax: MoneyInput;
}

/** ResLab's grand total, proven by its own parts (exact to the cent). */
export function grandTotalProven(grandTotal: MoneyInput, parts: ReslabTotalParts): boolean {
  const grand = toCents(grandTotal);
  const sub = toCents(parts.subtotal);
  const fees = toCents(parts.fees);
  const ltd = toCents(parts.longTermDiscount ?? 0);
  const tax = toCents(parts.tax);
  return grand !== null && sub !== null && fees !== null && ltd !== null && tax !== null && sub + fees - ltd + tax === grand;
}

export type FallbackDueInput =
  | {
      source: "reslab";
      /** In DOLLARS, like every MoneyInput. The recorded due-at-location (null = missing). */
      recordedDue: MoneyInput;
      grandTotal: MoneyInput;
      /** Verified HERE, independently of the breakdown's first refusal (round-4
       *  confirmation: a promo or fee refusal fired before the identity check
       *  and let an inflated grand total vouch for a $200 due on an $88 booking). */
      parts: ReslabTotalParts;
      /** Why the breakdown was refused (null when it agreed, or none was built). */
      refusal: string | null;
      cancelled: boolean;
    }
  | {
      source: "direct";
      /** In DOLLARS: the at-lot surcharge + its tax, or null when there is none. */
      recordedDue: MoneyInput;
      refusal: string | null;
      cancelled: boolean;
    };

export function fallbackDue(input: FallbackDueInput): FallbackDue {
  if (input.cancelled) return { kind: "none" };
  const due = toCents(input.recordedDue);
  if (input.source === "direct") {
    if (input.recordedDue === null || input.recordedDue === undefined) return { kind: "none" };
    return due === null ? { kind: "unconfirmed" } : due > 0 ? { kind: "amount", cents: due } : { kind: "none" };
  }
  if (due === null) return { kind: "unconfirmed" };
  if (due > 0) {
    // A positive due is believable only inside a grand total that is itself
    // proven by its parts — never by whichever check happened to fail first.
    const grand = toCents(input.grandTotal);
    if (grand === null || !grandTotalProven(input.grandTotal, input.parts) || due > grand) return { kind: "unconfirmed" };
    return { kind: "amount", cents: due };
  }
  const proven = input.refusal === null || CARD_SIDE_ONLY.some((r) => input.refusal!.startsWith(r));
  return proven ? { kind: "none" } : { kind: "unconfirmed" };
}
