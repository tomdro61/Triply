import { NextRequest, NextResponse } from "next/server";
import { reslab } from "@/lib/reslab/client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id) {
    return NextResponse.json(
      { error: "Reservation ID is required" },
      { status: 400 }
    );
  }

  try {
    // Fetch reservation from ResLab API
    const reservation = await reslab.getReservation(id);

    // ResLab returns data nested in history[0]
    const history = reservation.history?.[0];
    const location = history?.location;

    // Parse customer name from reserved_for
    const reservedFor = history?.reserved_for || reservation.reserved_by || "";
    const nameParts = reservedFor.split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    // Get dates from the first item in history
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dates = history?.dates?.[0] as any;
    const parkingRates = dates?.parking_rates?.[0];

    return NextResponse.json({
      reservation: {
        id: history?.id || reservation.reservation_number,
        reservationNumber: reservation.reservation_number,
        status: reservation.cancelled ? "cancelled" : "confirmed",
        grandTotal: history?.grand_total || 0,
        subtotal: history?.subtotal || 0,
        taxTotal: history?.total_tax || 0,
        feesTotal: history?.total_fees || 0,
        dueNow: history?.grand_total - (history?.due_at_location_total || 0),
        dueAtLocation: history?.due_at_location_total || 0,
        customer: {
          firstName,
          lastName,
          email: history?.email || "",
          phone: history?.phone || "",
        },
        items: dates ? [{
          type: "parking",
          fromDate: parkingRates?.from_date || dates.from_date,
          toDate: parkingRates?.to_date || dates.to_date,
          numberOfDays: parkingRates?.number_of_days || dates.number_of_days,
          numberOfSpots: parkingRates?.number_of_parkings || 1,
          parkingType: parkingRates?.rate?.location_parking_type?.name || dates.type?.name,
        }] : [],
        location: location
          ? {
              id: location.id,
              name: location.name,
              address: location.address,
              city: location.city,
              state: location.state?.code,
              zipCode: location.zip_code,
              phone: location.phone,
              latitude: location.latitude,
              longitude: location.longitude,
            }
          : null,
        extraFields: history?.extra_fields || [],
      },
    });
  } catch (error) {
    console.error("Error fetching reservation:", error);

    // Return a more specific error for not found
    if (error instanceof Error && error.message.includes("404")) {
      return NextResponse.json(
        { error: "Reservation not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: "Failed to fetch reservation" },
      { status: 500 }
    );
  }
}
