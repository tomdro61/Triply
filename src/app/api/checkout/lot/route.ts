import { NextRequest, NextResponse } from "next/server";
import { getLotById } from "@/lib/reslab/get-lot";
import { reslab } from "@/lib/reslab/client";
import { createPaymentIntent } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { convertTo24Hour } from "@/lib/utils/time";
import { captureAPIError } from "@/lib/sentry";
import { calculateServiceFee } from "@/lib/utils/service-fee";

const checkoutGetSchema = z.object({
  lotId: z.string().min(1),
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  checkinTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Invalid time format").optional(),
  checkoutTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Invalid time format").optional(),
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

  const lotId = searchParams.get("lotId")!;
  const checkin = searchParams.get("checkin")!;
  const checkout = searchParams.get("checkout")!;
  const checkinTime = searchParams.get("checkinTime") || "10:00 AM";
  const checkoutTime = searchParams.get("checkoutTime") || "2:00 PM";

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
        // Fall back to pricing from lot data
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
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/checkout/lot",
      method: "GET",
    });
    return NextResponse.json(
      { error: "Failed to fetch lot data" },
      { status: 500 }
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
  checkinTime: z.string().default("10:00 AM"),
  checkoutTime: z.string().default("2:00 PM"),
  parkingTypeId: z.number().int().positive(),
  customerEmail: z.string().email(),
  promoCode: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
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
    } = result.data;

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

    // Calculate Triply service fee on the parking base (sub_total + fees_total)
    const postServiceFee = calculateServiceFee(
      costResponse.reservation.sub_total + costResponse.reservation.fees_total
    );

    let verifiedTotal = costResponse.reservation.grand_total + postServiceFee;
    const dueAtLocation = costResponse.reservation.due_at_location;
    let verifiedDueNow = verifiedTotal - dueAtLocation;
    let discountPercent = 0;

    // Validate and apply promo code server-side
    if (promoCode) {
      const supabase = await createAdminClient();
      const { data: promo } = await supabase
        .from("promo_codes")
        .select("id, discount_percent, active, expires_at, max_uses, current_uses")
        .eq("code", promoCode.toUpperCase())
        .single();

      if (
        promo &&
        promo.active &&
        (!promo.expires_at || new Date(promo.expires_at) >= new Date()) &&
        (promo.max_uses === null || promo.current_uses < promo.max_uses)
      ) {
        discountPercent = promo.discount_percent;
        const discount = costResponse.reservation.sub_total * (discountPercent / 100);
        verifiedTotal = verifiedTotal - discount;
        verifiedDueNow = verifiedTotal - dueAtLocation;
      }
    }

    // Amount to charge via Stripe (due now, not due at location)
    const chargeAmount = Math.max(0, verifiedDueNow);

    if (chargeAmount <= 0) {
      return NextResponse.json(
        { error: "Invalid payment amount" },
        { status: 400 }
      );
    }

    // Create PaymentIntent for the server-verified amount
    const paymentIntent = await createPaymentIntent(chargeAmount, {
      lotId,
      locationId: String(locationId),
      checkin,
      checkout,
      customerEmail,
      verifiedTotal: String(verifiedTotal),
      serviceFee: String(postServiceFee),
      ...(promoCode && { promoCode }),
      ...(discountPercent > 0 && { discountPercent: String(discountPercent) }),
    });

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      costsToken: costResponse.costs_token,
      verifiedTotal,
      verifiedDueNow: chargeAmount,
      dueAtLocation,
      subtotal: costResponse.reservation.sub_total,
      taxTotal: costResponse.reservation.tax_total,
      feesTotal: costResponse.reservation.fees_total,
      serviceFee: postServiceFee,
      discountPercent,
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

