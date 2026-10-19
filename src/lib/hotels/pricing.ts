/**
 * Park & Stay pricing — integer cents throughout, every rate in basis points,
 * no environment reads (plan v3 §5). Never imported by components: the API
 * returns finished cents and the UI formats.
 *
 * Symbols (cents unless noted), from §5.1:
 *   R    room sell price            P    parking grand_total (the hotel's own lot)
 *   F    Triply service fee         C    Triply's parking commission for this lot
 *   net  LiteAPI retailRate.total at margin 0
 *   f    LiteAPI processing fee     s    Stripe % fee      x  Stripe fixed fee
 *   t    tax on markup              m    order margin (all fractions, here in bp)
 *
 *   profit(R) = R + F + C − f·R − net − (s·(R + P + F) + x) − t·max(0, R − net)
 *   floor     = the least integer R with profit(R) ≥ m·(R + P + F)
 *   roomSell  = max(SSP ?? 0, floor)
 *
 * Decision D1 (19 Oct): m = 0 — the whole order never loses money; pricing
 * above SSP is always allowed.
 */

import {
  LITEAPI_PROCESSING_FEE_PERCENT,
  ORDER_MARGIN_PERCENT,
  RESLAB_CHANNEL_FEE_PERCENT,
  ROOM_TAX_ON_MARKUP_PERCENT,
  STRIPE_FEE_FIXED_CENTS,
  STRIPE_FEE_PERCENT,
} from "./plans";

const BP = 10_000;

function assertCents(label: string, n: number, opts: { allowNegative?: boolean } = {}): void {
  if (!Number.isInteger(n) || (!opts.allowNegative && n < 0)) {
    throw new Error(`${label} must be ${opts.allowNegative ? "an" : "a non-negative"} integer number of cents, got ${n}`);
  }
}

/** A percentage → integer basis points; throws on anything finer than 0.01 %. */
export function percentToBp(percent: number): number {
  const bp = Math.round(percent * 100);
  if (!Number.isFinite(percent) || Math.abs(bp - percent * 100) > 1e-9 || bp < 0 || bp >= BP) {
    throw new Error(`percentage must be a finite value in [0, 100) with at most 2 decimals, got ${percent}`);
  }
  return bp;
}

/** Dollars-with-decimals (as LiteAPI and ResLab return) → integer cents, rounded half-up once. */
export function dollarsToCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error(`amount must be finite, got ${amount}`);
  return Math.round(amount * 100);
}

/** ceil(num / den) for integers, den > 0, without trusting a float boundary. */
function ceilDiv(num: number, den: number): number {
  const q = Math.floor(num / den);
  return q * den < num ? q + 1 : q;
}

export interface OrderFloorRates {
  stripeFeeBp: number;
  stripeFixedCents: number;
  liteApiFeeBp: number;
  marginBp: number;
  roomTaxOnMarkupBp: number;
}

export const ORDER_FLOOR_RATES: Readonly<OrderFloorRates> = {
  stripeFeeBp: percentToBp(STRIPE_FEE_PERCENT),
  stripeFixedCents: STRIPE_FEE_FIXED_CENTS,
  liteApiFeeBp: percentToBp(LITEAPI_PROCESSING_FEE_PERCENT),
  marginBp: percentToBp(ORDER_MARGIN_PERCENT),
  roomTaxOnMarkupBp: percentToBp(ROOM_TAX_ON_MARKUP_PERCENT),
};

export interface OrderInputs {
  /** LiteAPI `retailRate.total` at margin 0. */
  roomNetCents: number;
  /** This hotel's own parking quote `grand_total`. */
  parkingGrandTotalCents: number;
  serviceFeeCents: number;
  /** Triply's parking commission C for this lot (may be 0 when unknown, or negative). */
  commissionCents: number;
}

function validateOrder(o: OrderInputs): void {
  assertCents("roomNetCents", o.roomNetCents);
  assertCents("parkingGrandTotalCents", o.parkingGrandTotalCents);
  assertCents("serviceFeeCents", o.serviceFeeCents);
  assertCents("commissionCents", o.commissionCents, { allowNegative: true });
}

/**
 * profit(R) − m·(R + P + F), scaled by 10 000 (exact integer arithmetic).
 * ≥ 0 ⇔ the order meets the margin at room price R.
 */
export function orderSurplusBp(roomSellCents: number, o: OrderInputs, k: Readonly<OrderFloorRates> = ORDER_FLOOR_RATES): number {
  const R = roomSellCents;
  const { roomNetCents: net, parkingGrandTotalCents: P, serviceFeeCents: F, commissionCents: C } = o;
  return (
    (R + F + C - net) * BP -
    k.liteApiFeeBp * R -
    (k.stripeFeeBp * (R + P + F) + k.stripeFixedCents * BP) -
    k.roomTaxOnMarkupBp * Math.max(0, R - net) -
    k.marginBp * (R + P + F)
  );
}

/**
 * The order floor (§5.1): the least integer R ≥ 0 with orderSurplus(R) ≥ 0.
 * Solved per branch of max(0, R − net): first without the markup-tax term
 * (valid for R ≤ net), then with it (R ≥ net).
 */
export function orderFloorCents(o: OrderInputs, k: Readonly<OrderFloorRates> = ORDER_FLOOR_RATES): number {
  validateOrder(o);
  const { roomNetCents: net, parkingGrandTotalCents: P, serviceFeeCents: F, commissionCents: C } = o;
  const fixed = k.stripeFixedCents * BP;
  const variableOnPF = (k.stripeFeeBp + k.marginBp) * (P + F);
  const denNoTax = BP - k.liteApiFeeBp - k.stripeFeeBp - k.marginBp;
  const denTax = denNoTax - k.roomTaxOnMarkupBp;
  if (denTax <= 0) throw new Error("order floor rates leave no room for the sell price (denominator ≤ 0)");

  const noTax = ceilDiv(net * BP - (F + C) * BP + variableOnPF + fixed, denNoTax);
  let floor: number;
  if (noTax <= net) {
    floor = noTax;
  } else {
    floor = ceilDiv(net * (BP - k.roomTaxOnMarkupBp) - (F + C) * BP + variableOnPF + fixed, denTax);
  }
  floor = Math.max(0, floor);
  // Belt and braces: the integer solve must meet the margin (and be the least such R).
  if (orderSurplusBp(floor, o, k) < 0 && floor > 0) {
    throw new Error(`order floor ${floor} does not meet the margin — formula defect`);
  }
  return floor;
}

export type PriceBasis = "ssp" | "floor";

export interface RoomPriceInput extends OrderInputs {
  /** LiteAPI `retailRate.suggestedSellingPrice` (USD), cents; null when absent. */
  sspCents: number | null;
  /** Sum of `taxesAndFees[].amount` where `included === false`, cents (all USD — see rates.ts). */
  propertyFeesDueAtHotelCents: number;
}

export interface RoomPrice {
  roomNetCents: number;
  roomSellCents: number;
  /** 0 until M16 is answered (§5.2). */
  roomTaxCents: number;
  propertyFeesDueAtHotelCents: number;
  sspCents: number | null;
  floorCents: number;
  /** "ssp" when SSP set the price (SSP ≥ floor), "floor" when the order floor did (incl. no SSP). */
  priceBasis: PriceBasis;
}

export function priceRoom(input: RoomPriceInput, k: Readonly<OrderFloorRates> = ORDER_FLOOR_RATES): RoomPrice {
  assertCents("propertyFeesDueAtHotelCents", input.propertyFeesDueAtHotelCents);
  if (input.sspCents !== null) assertCents("sspCents", input.sspCents);
  const floorCents = orderFloorCents(input, k);
  const ssp = input.sspCents;
  const useSsp = ssp !== null && ssp >= floorCents;
  return {
    roomNetCents: input.roomNetCents,
    roomSellCents: useSsp ? ssp : floorCents,
    roomTaxCents: 0,
    propertyFeesDueAtHotelCents: input.propertyFeesDueAtHotelCents,
    sspCents: ssp,
    floorCents,
    priceBasis: useSsp ? "ssp" : "floor",
  };
}

// ───────────────────────── parking commission C (§5.1) ─────────────────────────

export interface CommissionInput {
  /** sub_total + fees_total − long_term_discount, cents (the base V9 confirms). */
  baseCents: number;
  /** ResLab `parking_commission_type` — the LOT's share. */
  commissionType: string | null | undefined;
  /** ResLab `parking_commission`: the lot's share, percent. */
  lotSharePercent: number | null | undefined;
  /** The quote's `reservation.location_commission` (the lot's share, dollars), cross-checked; null when absent. */
  quoteLocationCommissionCents: number | null;
}

export type CommissionResult =
  | { known: true; cents: number; lotSharePercent: number }
  | { known: false; cents: 0; reason: "type" | "range" | "cross_check" };

/**
 * C = round(base × (100 − pc)/100) − round(base × channelFee/100).
 * Unknown (type not "percentage", pc outside 1–99, or the quote's lot share
 * disagrees by more than 1¢, or is missing) → C = 0: the room then prices
 * above SSP; the hotel is NEVER hidden for this. The caller reports once.
 */
export function parkingCommission(input: CommissionInput, channelFeePercent: number = RESLAB_CHANNEL_FEE_PERCENT): CommissionResult {
  assertCents("baseCents", input.baseCents);
  if (input.commissionType !== "percentage") return { known: false, cents: 0, reason: "type" };
  const pc = input.lotSharePercent;
  if (typeof pc !== "number" || !Number.isFinite(pc) || pc < 1 || pc > 99) return { known: false, cents: 0, reason: "range" };
  const lotShareCents = Math.round((input.baseCents * pc) / 100);
  if (input.quoteLocationCommissionCents === null || Math.abs(input.quoteLocationCommissionCents - lotShareCents) > 1) {
    return { known: false, cents: 0, reason: "cross_check" };
  }
  const cents = Math.round((input.baseCents * (100 - pc)) / 100) - Math.round((input.baseCents * channelFeePercent) / 100);
  return { known: true, cents, lotSharePercent: pc };
}

// ───────────────────────── package total (§5.2) ─────────────────────────

export interface PackagePriceInput {
  room: RoomPrice;
  /** Parking charged online = the quote's grand_total (due_at_location is checked to be 0). */
  parkingOnlineCents: number;
  /** Triply service fee — parking base only. */
  serviceFeeCents: number;
  /** Phase A: no promo codes — always 0. */
  promoDiscountCents: number;
  /** Phase A: Park Guard is not pre-selected — always 0. */
  protectionPremiumCents: number;
}

export interface PackagePrice {
  /** What a PaymentIntent would charge today. */
  dueNowCents: number;
  /** Shown INSIDE the prominent total block as "paid at the hotel"; not charged. */
  propertyFeesDueAtHotelCents: number;
  /** The headline number: dueNow + fees paid at the hotel. */
  headlineTotalCents: number;
  roomSellCents: number;
  roomTaxCents: number;
  parkingOnlineCents: number;
  serviceFeeCents: number;
  promoDiscountCents: number;
  protectionPremiumCents: number;
}

/**
 * dueNow   = parkingOnline + serviceFee − promo + roomSell + roomTax + premium
 * headline = dueNow + feesPaidAtHotel
 */
export function packagePrice(input: PackagePriceInput): PackagePrice {
  assertCents("parkingOnlineCents", input.parkingOnlineCents);
  assertCents("serviceFeeCents", input.serviceFeeCents);
  assertCents("promoDiscountCents", input.promoDiscountCents);
  assertCents("protectionPremiumCents", input.protectionPremiumCents);
  const { room } = input;
  const dueNowCents =
    input.parkingOnlineCents +
    input.serviceFeeCents -
    input.promoDiscountCents +
    room.roomSellCents +
    room.roomTaxCents +
    input.protectionPremiumCents;
  if (dueNowCents < 0) {
    throw new Error(`package due-now went negative (${dueNowCents}); promo exceeds parking`);
  }
  return {
    dueNowCents,
    propertyFeesDueAtHotelCents: room.propertyFeesDueAtHotelCents,
    headlineTotalCents: dueNowCents + room.propertyFeesDueAtHotelCents,
    roomSellCents: room.roomSellCents,
    roomTaxCents: room.roomTaxCents,
    parkingOnlineCents: input.parkingOnlineCents,
    serviceFeeCents: input.serviceFeeCents,
    promoDiscountCents: input.promoDiscountCents,
    protectionPremiumCents: input.protectionPremiumCents,
  };
}
