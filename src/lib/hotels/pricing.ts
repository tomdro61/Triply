/**
 * Package pricing — integer cents throughout, margin passed as a parameter,
 * no environment reads anywhere under src/lib/hotels/** (plan §2.3). Never
 * imported by components: the API returns finished cents and the UI formats.
 *
 * Definitions (repeated in the plan §2.3 and the future migration):
 *   roomNetCents   what LiteAPI will charge our card (`retailRate.total` at margin 0)
 *   roomSellCents  what the customer pays for the room:
 *                  max(round(net × (1 + margin%)), sspCents)
 *   roomTaxCents   ONLY tax actually charged to the customer on the PaymentIntent.
 *                  0 until vendor question Q10 resolves in favour of collection.
 *   propertyFeesDueAtHotelCents  `taxesAndFees[].included === false` amounts:
 *                  displayed inside the prominent total as "payable at the hotel",
 *                  collected by nobody here, part of NO other formula. Never merged
 *                  into ResLab's `dueAtLocation`.
 */

export type PriceBasis = "margin" | "ssp_floor";

export interface RoomPriceInput {
  /** LiteAPI `retailRate.total[0].amount` at `margin: 0`, in cents. */
  roomNetCents: number;
  /** LiteAPI `retailRate.suggestedSellingPrice[0].amount`, in cents; null when absent. */
  sspCents: number | null;
  /** Sum of `taxesAndFees[].amount` where `included === false`, in cents. */
  propertyFeesDueAtHotelCents: number;
  /** HOTEL_MARGIN_PERCENT — passed in so tests and a future admin override stay pure. */
  marginPercent: number;
}

export interface RoomPrice {
  roomNetCents: number;
  roomSellCents: number;
  /** 0 until Q10 — see header. */
  roomTaxCents: number;
  propertyFeesDueAtHotelCents: number;
  sspCents: number | null;
  /** Which term bound: our margin, or the SSP floor. Stored on the row so `sell` is reconstructible. */
  priceBasis: PriceBasis;
  /** Realised margin in cents: sell − net. Never negative by construction. */
  hotelMarginCents: number;
}

function assertCents(label: string, n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer number of cents, got ${n}`);
  }
}

/** Dollars-with-decimals (as LiteAPI returns) → integer cents, rounded half-up once. */
export function dollarsToCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error(`amount must be finite, got ${amount}`);
  return Math.round(amount * 100);
}

export function priceRoom(input: RoomPriceInput): RoomPrice {
  assertCents("roomNetCents", input.roomNetCents);
  assertCents("propertyFeesDueAtHotelCents", input.propertyFeesDueAtHotelCents);
  if (input.sspCents !== null) assertCents("sspCents", input.sspCents);
  if (!Number.isFinite(input.marginPercent) || input.marginPercent < 0) {
    throw new Error(`marginPercent must be a non-negative number, got ${input.marginPercent}`);
  }
  const byMargin = Math.round(input.roomNetCents * (1 + input.marginPercent / 100));
  const floor = input.sspCents ?? 0;
  const roomSellCents = Math.max(byMargin, floor);
  const priceBasis: PriceBasis = roomSellCents === byMargin ? "margin" : "ssp_floor";
  return {
    roomNetCents: input.roomNetCents,
    roomSellCents,
    roomTaxCents: 0,
    propertyFeesDueAtHotelCents: input.propertyFeesDueAtHotelCents,
    sspCents: input.sspCents,
    priceBasis,
    hotelMarginCents: roomSellCents - input.roomNetCents,
  };
}

export interface PackagePriceInput {
  room: RoomPrice;
  /** Parking charged online (ResLab grand total minus any due-at-location — the paired lot is never due-at-location, so this is the grand total). */
  parkingOnlineCents: number;
  /** Triply service fee — parking base only (D5). */
  serviceFeeCents: number;
  /** Promo discount — parking sub_total only (§2.3); 0 when none. */
  promoDiscountCents: number;
  /** Park Guard premium when chosen — D2: never pre-selected on a package. 0 when none. */
  protectionPremiumCents: number;
}

export interface PackagePrice {
  /** What the PaymentIntent charges today. */
  dueNowCents: number;
  /** Shown INSIDE the prominent total block as "payable at the hotel"; not charged. */
  propertyFeesDueAtHotelCents: number;
  /** The headline number: dueNow + fees payable at the hotel (16 CFR 464 total-price rule). */
  headlineTotalCents: number;
  roomSellCents: number;
  roomTaxCents: number;
  parkingOnlineCents: number;
  serviceFeeCents: number;
  promoDiscountCents: number;
  protectionPremiumCents: number;
}

/**
 * dueNowCents = parkingOnline + serviceFee − promoDiscount + roomSell + roomTax + premium
 * The headline total ADDS the fees payable at the hotel so the biggest number on
 * the page is what the trip actually costs. The headline never reads "Total
 * paid today".
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
