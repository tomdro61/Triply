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

    return NextResponse.json({
      reservation: {
        id: reservation.id,
        reservationNumber: reservation.reservation_number,
        status: reservation.status,
        grandTotal: reservation.grand_total,
        dueNow: reservation.due_now,
        dueAtLocation: reservation.due_at_location,
        customer: {
          firstName: reservation.customer.first_name,
          lastName: reservation.customer.last_name,
          email: reservation.customer.email,
          phone: reservation.customer.phone,
        },
        items: reservation.items.map((item) => ({
          type: item.type,
          fromDate: item.from_date,
          toDate: item.to_date,
          numberOfDays: item.number_of_days,
          numberOfSpots: item.number_of_spots,
        })),
        location: reservation.location
          ? {
              id: reservation.location.id,
              name: reservation.location.name,
              address: reservation.location.address,
              city: reservation.location.city,
              state: reservation.location.state?.code,
              zipCode: reservation.location.zip_code,
              phone: reservation.location.phone,
              latitude: reservation.location.latitude,
              longitude: reservation.location.longitude,
            }
          : null,
        extraFields: reservation.extra_fields,
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
