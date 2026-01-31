import { NextRequest, NextResponse } from "next/server";
import { reslab } from "@/lib/reslab/client";
import { createAdminClient } from "@/lib/supabase/server";

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
  // Location info for storing in Supabase
  locationName?: string;
  locationAddress?: string;
  airportCode?: string;
  // Pricing info
  subtotal?: number;
  taxTotal?: number;
  feesTotal?: number;
  grandTotal?: number;
  // User ID for linking to account (if logged in)
  userId?: string | null;
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
      locationName,
      locationAddress,
      airportCode,
      subtotal,
      taxTotal,
      feesTotal,
      grandTotal,
      userId,
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

    // Save to Supabase
    try {
      const supabase = await createAdminClient();

      // Create or find customer
      let customerId: string;
      let existingCustomer = null;

      // If user is logged in, first try to find customer by user_id
      if (userId) {
        const { data: customerByUserId } = await supabase
          .from("customers")
          .select("id")
          .eq("user_id", userId)
          .single();

        if (customerByUserId) {
          existingCustomer = customerByUserId;
        }
      }

      // If not found by user_id, try to find by email
      if (!existingCustomer) {
        const { data: customerByEmail } = await supabase
          .from("customers")
          .select("id")
          .eq("email", customer.email)
          .single();

        if (customerByEmail) {
          existingCustomer = customerByEmail;
        }
      }

      if (existingCustomer) {
        customerId = existingCustomer.id;
        // Update customer info and link to user if logged in
        await supabase
          .from("customers")
          .update({
            first_name: customer.firstName,
            last_name: customer.lastName,
            phone: customer.phone,
            ...(userId && { user_id: userId }), // Link to user account if logged in
          })
          .eq("id", customerId);
      } else {
        // Create new customer
        const { data: newCustomer, error: customerError } = await supabase
          .from("customers")
          .insert({
            email: customer.email,
            first_name: customer.firstName,
            last_name: customer.lastName,
            phone: customer.phone,
            ...(userId && { user_id: userId }), // Link to user account if logged in
          })
          .select("id")
          .single();

        if (customerError) {
          console.error("Error creating customer:", customerError);
          throw customerError;
        }
        customerId = newCustomer.id;
      }

      // Create booking record
      const { error: bookingError } = await supabase.from("bookings").insert({
        customer_id: customerId,
        reslab_reservation_number: reservation.reservation_number,
        reslab_location_id: locationId,
        location_name: locationName || reservation.location?.name || `Location ${locationId}`,
        location_address: locationAddress || reservation.location?.address || "",
        airport_code: airportCode || "",
        check_in: fromDate,
        check_out: toDate,
        subtotal: subtotal || reservation.subtotal || 0,
        tax_total: taxTotal || reservation.tax_total || 0,
        fees_total: feesTotal || reservation.fees_total || 0,
        grand_total: grandTotal || reservation.grand_total || 0,
        vehicle_info: vehicle,
        status: "confirmed",
      });

      if (bookingError) {
        console.error("Error creating booking:", bookingError);
        // Don't fail the whole request - ResLab reservation was already created
      }
    } catch (supabaseError) {
      // Log but don't fail - ResLab reservation was successful
      console.error("Supabase save error:", supabaseError);
    }

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
