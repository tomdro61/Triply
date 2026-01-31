import { NextRequest, NextResponse } from "next/server";
import { getLotById } from "@/lib/reslab/get-lot";

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

    // Construct costData from lot's pricing (already fetched via getMinPrice)
    const costData = lot.pricing
      ? {
          costsToken: null, // We'll need to get this from getCost for actual booking
          grandTotal: lot.pricing.grandTotal,
          subtotal: lot.pricing.subtotal,
          taxTotal: lot.pricing.taxTotal,
          feesTotal: lot.pricing.feesTotal,
          dueAtLocation: lot.dueAtLocationAmount || 0,
          dueNow: lot.pricing.grandTotal - (lot.dueAtLocationAmount || 0),
          numberOfDays: lot.pricing.numberOfDays,
          soldOut: lot.availability === "unavailable",
        }
      : null;

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
