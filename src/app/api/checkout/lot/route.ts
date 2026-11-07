import { NextRequest, NextResponse } from "next/server";
import { getLotById } from "@/lib/reslab/get-lot";
import {
  getChannelLocationsNoSweep,
  isHiddenReslabLocation,
  isLocationBackoffError,
  isUsdPricedLocation,
} from "@/lib/reslab/search";
import { reslab, ReslabError } from "@/lib/reslab/client";
import { createPaymentIntent } from "@/lib/stripe/client";
import { z } from "zod";
import { convertTo24Hour } from "@/lib/utils/time";
import { captureAPIError } from "@/lib/sentry";
import { calculateServiceFee } from "@/lib/utils/service-fee";
import {
  getProtectionPlan,
  protectionMetadataPatch,
  STALE_CHECKOUT_MESSAGE,
} from "@/lib/parkguard/client";
import { protectionPlanCodeSchema } from "@/lib/validation/schemas";
import { lookupPromoRule, type PromoLookup } from "@/lib/promo/lookup";
import {
  normalisePromoCode,
  PROMO_PRICING_HEADER,
  PROMO_PRICING_VERSION,
  promoDiscountCents,
  promoRefusalMessage,
  type CheckoutPromoOutcome,
  type PromoDiscountResult,
  type PromoRule,
} from "@/lib/promo/discount";
import { promoStampMetadata } from "@/lib/promo/stamped-discount";
import { DirectInventoryUnavailableError } from "@/lib/direct/errors";
import { isDirectCheckoutOpen } from "@/lib/direct/flag";
import { quoteDirectCheckout, type DirectCheckoutQuote } from "@/lib/direct/checkout-quote";
import { parseDirectLotUnifiedId } from "@/lib/direct/store";
import {
  DIRECT_SURCHARGES_KEY,
  DIRECT_TAX_RATE_KEY,
  encodeSurchargeRates,
} from "@/lib/direct/vehicle-surcharge-metadata";
import type { CheckoutCostData } from "@/types/checkout";

// A slug lotId reaches the ~54-page ResLab sweep via getChannelLocationsCached
// (40s budget). The ceiling must sit above it so the sweep settles and arms its
// circuit breaker rather than being killed mid-flight — see the sibling routes.
export const maxDuration = 60;

const checkoutGetSchema = z.object({
  lotId: z.string().min(1),
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  checkinTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Check-in time is required"),
  checkoutTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Check-out time is required"),
});

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  // Validate query parameters
  const validation = checkoutGetSchema.safeParse({
    lotId: searchParams.get("lotId") || undefined,
    checkin: searchParams.get("checkin") || undefined,
    checkout: searchParams.get("checkout") || undefined,
    checkinTime: searchParams.get("checkinTime") || undefined,
    checkoutTime: searchParams.get("checkoutTime") || undefined,
  });

  if (!validation.success) {
    return NextResponse.json(
      { error: "Invalid parameters", fields: validation.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const { lotId, checkin, checkout, checkinTime, checkoutTime } = validation.data;

  try {
    // Convert times to 24-hour format
    const checkinTime24 = convertTo24Hour(checkinTime);
    const checkoutTime24 = convertTo24Hour(checkoutTime);
    const fromDate = `${checkin} ${checkinTime24}:00`;
    const toDate = `${checkout} ${checkoutTime24}:00`;

    // Get lot details (includes pricing from getMinPrice)
    const lot = await getLotById(lotId, fromDate, toDate);

    if (!lot) {
      return NextResponse.json({ error: "Lot not found" }, { status: 404 });
    }

    // Direct lots: priced by quoteDirectCheckout — the same function POST
    // charges from — never from ResLab-shaped fields a direct lot does not
    // have. Closed until DIRECT_BOOKING_OPEN (or the Preview-only checkout
    // flag, review R11); the booking widget keeps customers off this path too.
    if (lot.source === "direct") {
      if (!isDirectCheckoutOpen()) {
        return NextResponse.json(
          { error: "Online booking for this lot is not open yet", code: "direct_not_bookable_yet" },
          { status: 503, headers: { "Cache-Control": "no-store" } }
        );
      }
      const direct = await quoteDirectCheckout({
        payloadId: Number(lot.sourceId),
        fromDate,
        toDate,
        endpoint: "/api/checkout/lot",
      });
      if (!direct.ok) {
        return NextResponse.json(
          { error: direct.error, code: direct.code },
          { status: direct.status, headers: { "Cache-Control": "no-store" } }
        );
      }
      return NextResponse.json(
        { lot, costData: directCostData(direct), fromDate, toDate },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Get costs_token from getCost API for reservation creation
    let costData = null;
    if (lot.reslabLocationId && lot.pricing?.parkingTypes?.[0]?.id) {
      try {
        const costResponse = await reslab.getCost(lot.reslabLocationId, [
          {
            type: "parking",
            reservation_type: "parking",
            type_id: lot.pricing.parkingTypes[0].id,
            from_date: fromDate,
            to_date: toDate,
            number_of_spots: 1,
          },
        ]);

        const serviceFee = calculateServiceFee(
          costResponse.reservation.sub_total + costResponse.reservation.fees_total
        );
        costData = {
          costsToken: costResponse.costs_token,
          grandTotal: costResponse.reservation.grand_total,
          subtotal: costResponse.reservation.sub_total,
          taxTotal: costResponse.reservation.tax_total,
          feesTotal: costResponse.reservation.fees_total,
          serviceFee,
          dueAtLocation: costResponse.reservation.due_at_location,
          dueNow: costResponse.reservation.grand_total - costResponse.reservation.due_at_location + serviceFee,
          numberOfDays: costResponse.reservation.totals?.parking?.number_of_days,
          soldOut: costResponse.reservation.sold_out,
          parkingTypeId: lot.pricing.parkingTypes[0].id,
        };
      } catch (costError) {
        console.error("Error getting costs_token:", costError);
        // ResLab is degraded — capture so ops sees the upstream issue.
        // The display-only fallback below uses lot.pricing for "from $X"
        // estimates; costsToken stays null so the POST endpoint refuses
        // to create a PaymentIntent (no silent route into a failed checkout).
        captureAPIError(
          costError instanceof Error ? costError : new Error(String(costError)),
          { endpoint: "/api/checkout/lot", method: "GET", statusCode: 502 }
        );
        const fallbackServiceFee = lot.pricing
          ? calculateServiceFee((lot.pricing.subtotal || 0) + (lot.pricing.feesTotal || 0))
          : 0;
        costData = lot.pricing
          ? {
              costsToken: null,
              grandTotal: lot.pricing.grandTotal,
              subtotal: lot.pricing.subtotal,
              taxTotal: lot.pricing.taxTotal,
              feesTotal: lot.pricing.feesTotal,
              serviceFee: fallbackServiceFee,
              dueAtLocation: lot.dueAtLocationAmount || 0,
              dueNow: (lot.pricing.grandTotal || 0) - (lot.dueAtLocationAmount || 0) + fallbackServiceFee,
              numberOfDays: lot.pricing.numberOfDays,
              soldOut: lot.availability === "unavailable",
              parkingTypeId: null,
            }
          : null;
      }
    } else if (lot.pricing) {
      // No parking type ID available, use lot pricing
      const lotServiceFee = calculateServiceFee(
        (lot.pricing.subtotal || 0) + (lot.pricing.feesTotal || 0)
      );
      costData = {
        costsToken: null,
        grandTotal: lot.pricing.grandTotal,
        subtotal: lot.pricing.subtotal,
        taxTotal: lot.pricing.taxTotal,
        feesTotal: lot.pricing.feesTotal,
        serviceFee: lotServiceFee,
        dueAtLocation: lot.dueAtLocationAmount || 0,
        dueNow: (lot.pricing.grandTotal || 0) - (lot.dueAtLocationAmount || 0) + lotServiceFee,
        numberOfDays: lot.pricing.numberOfDays,
        soldOut: lot.availability === "unavailable",
        parkingTypeId: null,
      };
    }

    return NextResponse.json({
      lot,
      costData,
      fromDate,
      toDate,
    });
  } catch (error) {
    console.error("Checkout lot API error:", error);
    // The location-list circuit breaker fires on EVERY request while it's open
    // and already self-reports once per backoff window with a far more
    // diagnostic message. Capturing it here too buries the root-cause 429 under
    // derived events — the failure mode that let 1,311 Sentry events go
    // unnoticed for ~4 weeks. Matches /api/search. Every other error is still
    // captured unconditionally.
    // The direct-inventory read failure is likewise already reported (throttled)
    // by the store that failed, so it is not re-captured per request here.
    const directUnavailable = error instanceof DirectInventoryUnavailableError;
    if (!isLocationBackoffError(error) && !directUnavailable) {
      captureAPIError(error instanceof Error ? error : new Error(String(error)), {
        endpoint: "/api/checkout/lot",
        method: "GET",
      });
    }
    // 503 (not 500) when the upstream is transiently unavailable: it's the
    // honest status, and uptime monitors page on 500s.
    const transient =
      isLocationBackoffError(error) ||
      directUnavailable ||
      (error instanceof ReslabError && error.statusCode >= 500);
    return NextResponse.json(
      { error: transient ? "Parking data is temporarily unavailable" : "Failed to fetch lot data" },
      { status: transient ? 503 : 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// =============================================================================
// POST: Create PaymentIntent with server-verified price
// =============================================================================

const checkoutPostSchema = z.object({
  lotId: z.string().min(1),
  locationId: z.number().int().positive(),
  checkin: z.string().min(1),
  checkout: z.string().min(1),
  checkinTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Check-in time is required"),
  checkoutTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Check-out time is required"),
  parkingTypeId: z.number().int().positive(),
  customerEmail: z.string().email(),
  promoCode: z.string().optional(),
  // Required key, nullable value — see validation/schemas.ts for rationale.
  // The checkout form sends the customer's kept choice after Back, or null on
  // first entry (nothing is pre-selected since 2026-11-02; Plan A was the
  // default 2026-09-17 → 2026-11-02). null means parking-only. Later changes
  // on the payment step go through /api/checkout/lot/update-pi.
  protectionPlanCode: protectionPlanCodeSchema,
  // The terms-checkbox version this checkout renders; stamped on the
  // PaymentIntent only if known (dispute evidence quotes it). Optional: a tab
  // opened before versioning sends none.
  termsVersion: z.string().max(32).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    // The promo pricing the page speaks (a header: see PROMO_PRICING_HEADER).
    const promoPricing = request.headers.get(PROMO_PRICING_HEADER);
    // A checkout page loaded before the plan-tier deploy still posts the old
    // boolean. Refuse with an actionable message instead of a Zod issue.
    if (body && typeof body === "object" && "hasProtectionPlan" in body) {
      return NextResponse.json({ error: STALE_CHECKOUT_MESSAGE }, { status: 400 });
    }
    // A direct lot is chosen ONLY by an explicit inventorySource; every other
    // body takes the ResLab path exactly as before.
    if (body && typeof body === "object" && (body as Record<string, unknown>).inventorySource === "direct") {
      return await postDirect(body, promoPricing);
    }
    const result = checkoutPostSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    const {
      lotId,
      locationId,
      checkin,
      checkout,
      checkinTime,
      checkoutTime,
      parkingTypeId,
      customerEmail,
      promoCode,
      protectionPlanCode,
      termsVersion,
    } = result.data;
    if (promoFromStalePage(promoCode, promoPricing)) {
      return NextResponse.json({ error: STALE_CHECKOUT_MESSAGE, code: "checkout_stale" }, { status: 400 });
    }

    // A hidden lot (blocked list, or a ResLab test lot in production) never gets a PaymentIntent: the GET above already
    // 404s it, but a stale checkout or a hand-built POST would otherwise pay for it (Codex review, 2026-11-02).
    if (isHiddenReslabLocation(locationId)) {
      return NextResponse.json({ error: "Lot not found" }, { status: 404 });
    }
    // Same for a lot not priced in USD (our Canadian lots, isUsdPricedLocation):
    // the charge below is USD with no conversion. Fails CLOSED — a stale
    // checkout or a hand-built POST never reaches the GET's 404.
    const currency = await reslabLotCurrency(locationId);
    if (currency === "not_usd") {
      return NextResponse.json({ error: "Lot not found" }, { status: 404 });
    }
    if (currency === "unverified") {
      return NextResponse.json(
        { error: "We couldn't load this lot's price right now. Please try again in a moment." },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    // The promo code BEFORE the price: a lookup that fails creates no
    // PaymentIntent (it used to charge full price silently) and costs no
    // ResLab call.
    const promoLookup = promoCode ? await lookupPromoRule(promoCode, PROMO_LOOKUP_CONTEXT) : null;
    if (promoLookup?.kind === "unavailable") return promoLookupUnavailable();

    // Build dates for ResLab API
    const checkinTime24 = convertTo24Hour(checkinTime);
    const checkoutTime24 = convertTo24Hour(checkoutTime);
    const fromDate = `${checkin} ${checkinTime24}:00`;
    const toDate = `${checkout} ${checkoutTime24}:00`;

    // Get verified cost from ResLab server-side
    const costResponse = await reslab.getCost(locationId, [
      {
        type: "parking",
        reservation_type: "parking",
        type_id: parkingTypeId,
        from_date: fromDate,
        to_date: toDate,
        number_of_spots: 1,
      },
    ]);

    if (costResponse.reservation.sold_out) {
      return NextResponse.json(
        { error: "This parking option is sold out" },
        { status: 409 }
      );
    }

    const reservation = costResponse.reservation;
    // Calculate Triply service fee on the parking base (sub_total + fees_total)
    const postServiceFee = calculateServiceFee(reservation.sub_total + reservation.fees_total);
    const dueAtLocation = reservation.due_at_location;

    // Everything below is INTEGER CENTS: the discount stamp's readers check
    // these figures with exact equality (checkStampAgainstCharge).
    const serviceFeeCents = Math.round(postServiceFee * 100);
    const grandTotalCents = Math.round(reservation.grand_total * 100);
    // The parking paid online, before any discount — the most a discount may take.
    const onlineParkingCents = grandTotalCents - Math.round(dueAtLocation * 100);
    if (!Number.isSafeInteger(onlineParkingCents) || onlineParkingCents < 0 || !Number.isSafeInteger(serviceFeeCents)) {
      captureAPIError(
        new Error(`ResLab cost for location ${locationId} is unusable (grand_total ${reservation.grand_total}, due_at_location ${dueAtLocation}, service fee ${postServiceFee})`),
        { endpoint: "/api/checkout/lot", method: "POST", stage: "cost_unusable" }
      );
      return NextResponse.json(
        { error: "We couldn't load this lot's price right now. Please try again in a moment." },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    const preDiscountOnlineCents = onlineParkingCents + serviceFeeCents;

    // The promo, applied by the one rule (promoDiscountCents) to the server's
    // fresh price. A code that gives no discount here is reported back to the
    // checkout and stamps nothing.
    const applied =
      promoLookup?.kind === "rule"
        ? fromDiscount(
            promoLookup.rule,
            promoDiscountCents(promoLookup.rule, {
              parkingCents: Math.round((reservation.sub_total + reservation.fees_total) * 100),
              percentBaseCents: Math.round(reservation.sub_total * 100),
              onlineParkingCents,
              // reslabLotCurrency refused anything but USD above.
              currency: "USD",
            })
          )
        : unappliedPromo(promoLookup, promoCode);
    const discountCents = applied.rule ? applied.discountCents : 0;

    // The parking-only charge, BEFORE the protection premium. Stamped into PI
    // metadata (in CENTS — integer-safe, no float drift) so the /update-pi
    // endpoint can re-compute the amount safely when the customer toggles
    // protection on the payment step without re-calling ResLab. Also kept as
    // dollars for backwards compat with PIs already in flight before the
    // cents-storage rollout.
    const parkingOnlyChargeAmountCents = preDiscountOnlineCents - discountCents;
    const parkingOnlyChargeAmount = parkingOnlyChargeAmountCents / 100;

    // Refuse a non-positive PARKING baseline before any premium is added. Since
    // a returning customer's tier is applied at creation, a heavy promo on a due-at-lot
    // booking could otherwise mint a $12.99-only PaymentIntent whose baseline
    // is 0 — /update-pi then rejects every change (422), so the customer could
    // not decline protection, and the Pay button would read $0.00 against a
    // live hold. A discount can no longer exceed the online parking (the rule
    // caps it), so this holds the service fee at least; kept as the guard.
    if (parkingOnlyChargeAmountCents <= 0) {
      return NextResponse.json(
        { error: "Invalid payment amount" },
        { status: 400 }
      );
    }

    const protectionPlan = getProtectionPlan(protectionPlanCode);
    const protectionPremiumCents = Math.round((protectionPlan?.price ?? 0) * 100);
    // Amount to charge via Stripe (due now, not due at location)
    const chargeCents = parkingOnlyChargeAmountCents + protectionPremiumCents;
    const chargeAmount = chargeCents / 100;
    const verifiedTotal = (grandTotalCents + serviceFeeCents - discountCents + protectionPremiumCents) / 100;

    // Create PaymentIntent for the server-verified amount
    const paymentIntent = await createPaymentIntent(chargeAmount, {
      lotId,
      locationId: String(locationId),
      checkin,
      checkout,
      // Times and parking type are stamped so the server can reconstruct WHAT
      // the customer paid for without trusting a client payload. The dead-browser
      // fulfilment paths (/checkout/complete and the Stripe webhook) have no
      // client to ask, and date-only checkin/checkout can't distinguish a 10 AM
      // pickup from a 10 PM one — a full extra billed day. Stored as the literal
      // 12-hour strings the customer picked; never parsed as a Date.
      checkinTime,
      checkoutTime,
      parkingTypeId: String(parkingTypeId),
      customerEmail,
      verifiedTotal: String(verifiedTotal),
      serviceFee: String(postServiceFee),
      parkingOnlyChargeAmount: String(parkingOnlyChargeAmount),
      parkingOnlyChargeAmountCents: String(parkingOnlyChargeAmountCents),
      // The discount stamp (code, discountCents and checkout's two figures,
      // always together) — only when the code gave a discount.
      ...(applied.rule &&
        promoStampMetadata({
          code: applied.rule.code,
          percent: applied.rule.percent,
          discountCents,
          onlineParkingCents,
          preDiscountOnlineCents,
        })),
      // Tier code + its price are written as a PAIR (see
      // readProtectionMetadata): /api/reservations/pending stages the tier from
      // it, and fulfilment books, prices, and enrols exactly what it says — a
      // half-present pair is an integrity error there, never "no protection".
      // Deleted as a pair by /update-pi when the customer picks "no protection".
      ...(protectionPlan && protectionMetadataPatch(protectionPlan)),
      // Explicit on both branches (A-28): readers select the inventory adapter
      // from this, never from the absence of a direct key.
      inventorySource: "reslab",
    }, termsVersion);

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      costsToken: costResponse.costs_token,
      verifiedTotal,
      verifiedDueNow: chargeAmount,
      chargeCents,
      dueAtLocation,
      subtotal: reservation.sub_total,
      taxTotal: reservation.tax_total,
      feesTotal: reservation.fees_total,
      serviceFee: postServiceFee,
      promo: applied.outcome,
    });
  } catch (error) {
    console.error("Checkout POST error:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/checkout/lot",
      method: "POST",
    });
    return NextResponse.json(
      { error: "Failed to create payment intent" },
      { status: 500 }
    );
  }
}


/**
 * Whether a ResLab lot is priced in USD: the channel list this instance
 * already holds first (getChannelLocationsNoSweep never calls ResLab — never
 * the 54-page sweep while a customer waits to pay); no list, or the lot not in
 * it → one /locations/{id} read. "unverified" when that fails too — the caller
 * refuses rather than charge an unknown currency as USD.
 */
async function reslabLotCurrency(locationId: number): Promise<"usd" | "not_usd" | "unverified"> {
  const listed = (await getChannelLocationsNoSweep())?.find((loc) => loc.id === locationId);
  if (listed) return isUsdPricedLocation(listed) ? "usd" : "not_usd";
  try {
    const location = await reslab.getLocation(locationId);
    return isUsdPricedLocation(location) ? "usd" : "not_usd";
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/checkout/lot",
      method: "POST",
      stage: "currency_check_unverified",
    });
    return "unverified";
  }
}

const PROMO_LOOKUP_CONTEXT = { endpoint: "/api/checkout/lot", method: "POST" };

/**
 * A promo code from a page that does not speak this promo pricing (no or
 * another PROMO_PRICING_HEADER) — one loaded before PR 2. Such a page prices
 * the code itself and never reads this route's verdict: a percent code capped
 * at the online parking would be charged more than its Pay button shows, a
 * fixed code less. Refused BEFORE any PaymentIntent with the stale-page
 * message — the customer reloads and applies the code again. A page with no
 * code is unaffected.
 */
function promoFromStalePage(promoCode: string | undefined, promoPricing: string | null): boolean {
  return promoCode !== undefined && promoPricing !== String(PROMO_PRICING_VERSION);
}

/** The promo lookup failed (already reported): no PaymentIntent, the customer retries. */
function promoLookupUnavailable(): NextResponse {
  return NextResponse.json(
    { error: "We couldn't check your promo code right now. Please try again — you have not been charged.", code: "promo_lookup_unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}

type AppliedPromoCode =
  | { rule: PromoRule; discountCents: number; outcome: CheckoutPromoOutcome }
  | { rule: null; outcome: CheckoutPromoOutcome | null };

/**
 * No code, or one its own row refused (unknown / inactive / expired / used up
 * / not available): nothing is applied and nothing stamped; the checkout is
 * told why. (A failed lookup never gets here — the route answers 503 first.)
 */
function unappliedPromo(lookup: Exclude<PromoLookup, { kind: "rule" }> | null, sentCode: string | undefined): AppliedPromoCode {
  if (lookup?.kind !== "refused" || sentCode === undefined) return { rule: null, outcome: null };
  return { rule: null, outcome: { code: normalisePromoCode(sentCode), refused: lookup.reason, message: lookup.message } };
}

/**
 * A usable code's verdict on the cart (promoDiscountCents): applied, with its
 * cents, or refused by the cart (below the minimum, pay-at-the-lot).
 */
function fromDiscount(rule: PromoRule, result: PromoDiscountResult): AppliedPromoCode {
  if ("refused" in result) {
    return { rule: null, outcome: { code: rule.code, refused: result.refused, message: promoRefusalMessage(result.refused, rule) } };
  }
  return {
    rule,
    discountCents: result.cents,
    outcome: { code: rule.code, kind: rule.amountCents !== null ? "fixed" : "percent", appliedCents: result.cents },
  };
}

// =============================================================================
// Direct lots (plan A-28 + vehicle-surcharge plan R5)
// =============================================================================

/** GET's costData for a direct lot — the same numbers POST charges. */
function directCostData(direct: Extract<DirectCheckoutQuote, { ok: true }>): CheckoutCostData {
  const { quote, days, lot } = direct;
  return {
    costsToken: null,
    grandTotal: quote.grandTotalCents / 100,
    subtotal: quote.subtotalCents / 100,
    taxTotal: quote.taxTotalCents / 100,
    feesTotal: 0,
    serviceFee: quote.serviceFeeCents / 100,
    dueAtLocation: 0,
    dueNow: (quote.grandTotalCents + quote.serviceFeeCents) / 100,
    numberOfDays: days,
    soldOut: false,
    parkingTypeId: null,
    direct: {
      days,
      taxRatePercent: lot.taxRatePercent,
      vehicleSurcharges: lot.vehicleSurcharges.map((v) => ({ code: v.code, label: v.label, dailyRateCents: v.dailyRateCents })),
    },
  };
}

const directCheckoutPostSchema = z
  .object({
    inventorySource: z.literal("direct"),
    lotId: z.string().regex(/^direct-\d{1,9}$/, "Invalid lot"),
    checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
    checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
    checkinTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Check-in time is required"),
    checkoutTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Check-out time is required"),
    customerEmail: z.string().email(),
    promoCode: z.string().optional(),
    // Required key, nullable value (see checkoutPostSchema).
    protectionPlanCode: protectionPlanCodeSchema,
    // See checkoutPostSchema: the rendered terms-checkbox version, optional.
    termsVersion: z.string().max(32).optional(),
  })
  .strict();

/**
 * PaymentIntent for a DIRECT lot. Charge = grandTotal − discount + serviceFee
 * (+ Park Guard premium), all from quoteDirectCheckout on a fresh lot read.
 * Everything fulfilment and the pending route need is stamped into metadata IN
 * CENTS (B8), plus the tax rate and the vehicle-surcharge rates the customer is
 * shown (R5) — the at-lot estimate is computed from these, never from a later
 * CMS read or the client. The surcharge itself is never charged.
 */
async function postDirect(body: unknown, promoPricing: string | null): Promise<NextResponse> {
  if (!isDirectCheckoutOpen()) {
    return NextResponse.json(
      { error: "Online booking for this lot is not open yet", code: "direct_not_bookable_yet" },
      { status: 503 }
    );
  }
  const parsed = directCheckoutPostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const { lotId, checkin, checkout, checkinTime, checkoutTime, customerEmail, promoCode, protectionPlanCode, termsVersion } =
    parsed.data;
  if (promoFromStalePage(promoCode, promoPricing)) {
    return NextResponse.json({ error: STALE_CHECKOUT_MESSAGE, code: "checkout_stale" }, { status: 400 });
  }
  const payloadId = parseDirectLotUnifiedId(lotId);
  if (payloadId === null) {
    return NextResponse.json({ error: "Invalid lot" }, { status: 400 });
  }

  // As on the ResLab path: a failed lookup creates no PaymentIntent.
  const promoLookup = promoCode ? await lookupPromoRule(promoCode, PROMO_LOOKUP_CONTEXT) : null;
  if (promoLookup?.kind === "unavailable") return promoLookupUnavailable();

  const fromDate = `${checkin} ${convertTo24Hour(checkinTime)}:00`;
  const toDate = `${checkout} ${convertTo24Hour(checkoutTime)}:00`;
  const direct = await quoteDirectCheckout({
    payloadId,
    fromDate,
    toDate,
    promo: promoLookup?.kind === "rule" ? promoLookup.rule : null,
    endpoint: "/api/checkout/lot",
  });
  if (!direct.ok) {
    return NextResponse.json({ error: direct.error, code: direct.code }, { status: direct.status });
  }
  const { lot, quote, days } = direct;
  // computeDirectQuote applied the same rule (promoDiscountCents) to its own
  // figures; its verdict is non-null exactly when it was given a rule.
  let applied: AppliedPromoCode;
  if (promoLookup?.kind === "rule") {
    if (quote.promo === null) throw new Error("computeDirectQuote returned no promo verdict for a promo rule");
    applied = fromDiscount(promoLookup.rule, quote.promo);
  } else {
    applied = unappliedPromo(promoLookup, promoCode);
  }

  // Same refusal as the ResLab branch: never a premium-only PaymentIntent.
  const parkingOnlyChargeAmountCents = quote.chargeCents;
  if (parkingOnlyChargeAmountCents <= 0) {
    return NextResponse.json({ error: "Invalid payment amount" }, { status: 400 });
  }
  const parkingOnlyChargeAmount = parkingOnlyChargeAmountCents / 100;

  const protectionPlan = getProtectionPlan(protectionPlanCode);
  const protectionPremiumCents = Math.round((protectionPlan?.price ?? 0) * 100);
  const chargeCents = parkingOnlyChargeAmountCents + protectionPremiumCents;
  const chargeAmount = chargeCents / 100;
  const serviceFee = quote.serviceFeeCents / 100;
  const terms = directCostData(direct).direct;

  const paymentIntent = await createPaymentIntent(chargeAmount, {
    inventorySource: "direct",
    lotId,
    directLotId: String(payloadId),
    checkin,
    checkout,
    // Literal 12-hour strings the customer picked; never parsed as a Date.
    checkinTime,
    checkoutTime,
    customerEmail,
    verifiedTotal: String(chargeAmount),
    serviceFee: String(serviceFee),
    parkingOnlyChargeAmount: String(parkingOnlyChargeAmount),
    parkingOnlyChargeAmountCents: String(parkingOnlyChargeAmountCents),
    // The same discount stamp as a ResLab PaymentIntent; the whole grand total
    // is paid online, so the online parking is the grand total.
    ...(applied.rule &&
      promoStampMetadata({
        code: applied.rule.code,
        percent: applied.rule.percent,
        discountCents: quote.discountCents,
        onlineParkingCents: quote.grandTotalCents,
        preDiscountOnlineCents: quote.grandTotalCents + quote.serviceFeeCents,
      })),
    ...(protectionPlan && protectionMetadataPatch(protectionPlan)),
    // B8: the money authority for a direct booking, in cents.
    directRateCents: String(lot.rateCents),
    directDays: String(days),
    directSubtotalCents: String(quote.subtotalCents),
    directTaxCents: String(quote.taxTotalCents),
    directGrandTotalCents: String(quote.grandTotalCents),
    directDiscountCents: String(quote.discountCents),
    directServiceFeeCents: String(quote.serviceFeeCents),
    // R5: the terms the at-lot vehicle estimate is computed from.
    [DIRECT_TAX_RATE_KEY]: String(lot.taxRatePercent),
    [DIRECT_SURCHARGES_KEY]: encodeSurchargeRates(lot.vehicleSurcharges),
  }, termsVersion);

  return NextResponse.json({
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
    costsToken: null,
    verifiedTotal: chargeAmount,
    verifiedDueNow: chargeAmount,
    chargeCents,
    dueAtLocation: 0,
    subtotal: quote.subtotalCents / 100,
    taxTotal: quote.taxTotalCents / 100,
    feesTotal: 0,
    serviceFee,
    promo: applied.outcome,
    direct: terms,
  });
}
