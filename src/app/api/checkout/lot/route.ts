import { NextRequest, NextResponse } from "next/server";
import { getLotById } from "@/lib/reslab/get-lot";
import { reslab, ReslabCostResponse } from "@/lib/reslab/client";

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

    // Get lot details
    const lot = await getLotById(lotId, fromDate, toDate);

    if (!lot) {
      return NextResponse.json({ error: "Lot not found" }, { status: 404 });
    }

    // Get cost with costs_token for price guarantee
    let costData: ReslabCostResponse | null = null;
    if (lot.reslabLocationId) {
      try {
        // Get parking types
        const typesData = await reslab.getLocationTypes(lot.reslabLocationId);
        const parkingTypes = typesData.parking || [];

        if (parkingTypes.length > 0) {
          costData = await reslab.getCost(lot.reslabLocationId, [
            {
              type: "parking",
              reservation_type: "parking",
              type_id: parkingTypes[0].id,
              from_date: fromDate,
              to_date: toDate,
              number_of_spots: 1,
            },
          ]);
        }
      } catch (error) {
        console.error("Error getting cost for checkout:", error);
      }
    }

    return NextResponse.json({
      lot,
      costData: costData
        ? {
            costsToken: costData.costs_token,
            grandTotal: costData.reservation.grand_total,
            subtotal: costData.reservation.sub_total,
            taxTotal: costData.reservation.tax_total,
            feesTotal: costData.reservation.fees_total,
            dueAtLocation: costData.reservation.due_at_location,
            dueNow: costData.reservation.due_now,
            numberOfDays: costData.reservation.totals?.parking?.number_of_days,
            soldOut: costData.reservation.sold_out,
          }
        : null,
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
