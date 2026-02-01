import { NextRequest, NextResponse } from "next/server";
import { getLotById } from "@/lib/reslab/get-lot";
import { reslab } from "@/lib/reslab/client";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const lotId = searchParams.get("lotId");
  const checkin = searchParams.get("checkin");
  const checkout = searchParams.get("checkout");
  const checkinTime = searchParams.get("checkinTime") || "10:00 AM";
  const checkoutTime = searchParams.get("checkoutTime") || "2:00 PM";

  if (!lotId) {
    return NextResponse.json({ error: "Lot ID is required" }, { status: 400 });
  }

  if (!checkin || !checkout) {
    return NextResponse.json(
      { error: "Check-in and check-out dates are required" },
      { status: 400 }
    );
  }

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

        costData = {
          costsToken: costResponse.costs_token,
          grandTotal: costResponse.reservation.grand_total,
          subtotal: costResponse.reservation.sub_total,
          taxTotal: costResponse.reservation.tax_total,
          feesTotal: costResponse.reservation.fees_total,
          dueAtLocation: costResponse.reservation.due_at_location,
          dueNow: costResponse.reservation.grand_total - costResponse.reservation.due_at_location,
          numberOfDays: costResponse.reservation.totals?.parking?.number_of_days,
          soldOut: costResponse.reservation.sold_out,
          parkingTypeId: lot.pricing.parkingTypes[0].id,
        };
      } catch (costError) {
        console.error("Error getting costs_token:", costError);
        // Fall back to pricing from lot data
        costData = lot.pricing
          ? {
              costsToken: null,
              grandTotal: lot.pricing.grandTotal,
              subtotal: lot.pricing.subtotal,
              taxTotal: lot.pricing.taxTotal,
              feesTotal: lot.pricing.feesTotal,
              dueAtLocation: lot.dueAtLocationAmount || 0,
              dueNow: (lot.pricing.grandTotal || 0) - (lot.dueAtLocationAmount || 0),
              numberOfDays: lot.pricing.numberOfDays,
              soldOut: lot.availability === "unavailable",
              parkingTypeId: null,
            }
          : null;
      }
    } else if (lot.pricing) {
      // No parking type ID available, use lot pricing
      costData = {
        costsToken: null,
        grandTotal: lot.pricing.grandTotal,
        subtotal: lot.pricing.subtotal,
        taxTotal: lot.pricing.taxTotal,
        feesTotal: lot.pricing.feesTotal,
        dueAtLocation: lot.dueAtLocationAmount || 0,
        dueNow: (lot.pricing.grandTotal || 0) - (lot.dueAtLocationAmount || 0),
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
    return NextResponse.json(
      { error: "Failed to fetch lot data" },
      { status: 500 }
    );
  }
}

function convertTo24Hour(time12h: string): string {
  const [time, modifier] = time12h.split(" ");
  let [hours, minutes] = time.split(":");

  if (hours === "12") {
    hours = modifier === "AM" ? "00" : "12";
  } else if (modifier === "PM") {
    hours = String(parseInt(hours, 10) + 12);
  }

  return `${hours.padStart(2, "0")}:${minutes}`;
}
