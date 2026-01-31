import { NextRequest, NextResponse } from "next/server";
import { reslab } from "@/lib/reslab/client";

interface CreateReservationBody {
  locationId: number;
  costsToken: string;
  fromDate: string;
  toDate: string;
  parkingTypeId: number;
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  vehicle: {
    make: string;
    model: string;
    color: string;
    licensePlate: string;
    state: string;
  };
  extraFields?: Record<string, string>;
}

export async function POST(request: NextRequest) {
  try {
    const body: CreateReservationBody = await request.json();

    const {
      locationId,
      costsToken,
      fromDate,
      toDate,
      parkingTypeId,
      customer,
      vehicle,
      extraFields,
    } = body;

    // Validate required fields
    if (!locationId || !costsToken || !fromDate || !toDate || !parkingTypeId) {
      return NextResponse.json(
        { error: "Missing required booking parameters" },
        { status: 400 }
      );
    }

    if (!customer.firstName || !customer.lastName || !customer.email || !customer.phone) {
      return NextResponse.json(
        { error: "Missing required customer information" },
        { status: 400 }
      );
    }

    // Build extra fields for API
    const apiExtraFields: Record<string, string> = {
      // Standard vehicle fields
      car_make: vehicle.make,
      car_model: vehicle.model,
      car_makemodel: `${vehicle.make} ${vehicle.model}`, // Combined field required by ResLab
      car_color: vehicle.color,
      license_plate: vehicle.licensePlate,
      license_plate_state: vehicle.state,
      // Include any dynamic extra fields
      ...extraFields,
    };

    // Create reservation via ResLab API
    const fullName = `${customer.firstName} ${customer.lastName}`;
    const reservation = await reslab.createReservation({
      location_id: locationId,
      costs_token: costsToken,
      reserved_by: fullName,
      reserved_for: fullName,
      phone: customer.phone,
      email: customer.email,
      items: [
        {
          type: "parking",
          reservation_type: "parking",
          type_id: parkingTypeId,
          from_date: fromDate,
          to_date: toDate,
          number_of_spots: 1,
        },
      ],
      ...apiExtraFields,
    });

    return NextResponse.json({
      success: true,
      reservation: {
        id: reservation.id,
        reservationNumber: reservation.reservation_number,
        status: reservation.status,
        grandTotal: reservation.grand_total,
        dueNow: reservation.due_now,
        dueAtLocation: reservation.due_at_location,
        // Customer data may not be in the response, use the input data as fallback
        customer: reservation.customer
          ? {
              firstName: reservation.customer.first_name,
              lastName: reservation.customer.last_name,
              email: reservation.customer.email,
              phone: reservation.customer.phone,
            }
          : {
              firstName: customer.firstName,
              lastName: customer.lastName,
              email: customer.email,
              phone: customer.phone,
            },
        items: reservation.items?.map((item) => ({
          type: item.type,
          fromDate: item.from_date,
          toDate: item.to_date,
          numberOfDays: item.number_of_days,
          numberOfSpots: item.number_of_spots,
        })) || [],
        location: reservation.location
          ? {
              id: reservation.location.id,
              name: reservation.location.name,
              address: reservation.location.address,
              city: reservation.location.city,
              state: reservation.location.state?.code,
              zipCode: reservation.location.zip_code,
              phone: reservation.location.phone,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("Reservation creation error:", error);

    // Check if it's an API error with a message
    if (error instanceof Error) {
      return NextResponse.json(
        { error: error.message || "Failed to create reservation" },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: "Failed to create reservation" },
      { status: 500 }
    );
  }
}
