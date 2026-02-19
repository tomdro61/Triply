import { NextRequest, NextResponse } from "next/server";
import { reslab, ReslabError, stripHtml } from "@/lib/reslab/client";
import { createAdminClient } from "@/lib/supabase/server";
import { sendBookingConfirmation } from "@/lib/resend/send-booking-confirmation";
import { sendAdminBookingNotification } from "@/lib/resend/send-admin-booking-notification";
import { reservationSchema } from "@/lib/validation/schemas";
import { stripe } from "@/lib/stripe/client";
import { capturePaymentError } from "@/lib/sentry";

const DEV_SKIP_PAYMENT =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_DEV_SKIP_PAYMENT === "true";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate with Zod
    const result = reservationSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

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
      stripePaymentIntentId,
    } = result.data;

    // Verify Stripe payment (unless dev mode)
    if (!DEV_SKIP_PAYMENT) {
      if (!stripePaymentIntentId) {
        return NextResponse.json(
          { error: "Payment verification required" },
          { status: 400 }
        );
      }

      // Check for replay — has this PaymentIntent already been used?
      const supabaseCheck = await createAdminClient();
      const { data: existingBooking } = await supabaseCheck
        .from("bookings")
        .select("id")
        .eq("stripe_payment_intent_id", stripePaymentIntentId)
        .single();

      if (existingBooking) {
        return NextResponse.json(
          { error: "This payment has already been used for a reservation" },
          { status: 409 }
        );
      }

      // Verify PaymentIntent status with Stripe
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId);

        if (paymentIntent.status !== "succeeded") {
          capturePaymentError(
            new Error(`PaymentIntent status is ${paymentIntent.status}, expected succeeded`),
            { stripePaymentIntentId, amount: paymentIntent.amount / 100 }
          );
          return NextResponse.json(
            { error: "Payment has not been completed" },
            { status: 402 }
          );
        }
      } catch (stripeError) {
        capturePaymentError(
          stripeError instanceof Error ? stripeError : new Error("Stripe verification failed"),
          { stripePaymentIntentId }
        );
        return NextResponse.json(
          { error: "Payment verification failed" },
          { status: 500 }
        );
      }
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

    // Get history data for use throughout the response handling
    const resHistory = reservation.history?.[0];

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
        location_name: locationName || resHistory?.location?.name || `Location ${locationId}`,
        location_address: locationAddress || resHistory?.location?.address || "",
        airport_code: airportCode || "",
        check_in: fromDate,
        check_out: toDate,
        subtotal: subtotal || resHistory?.subtotal || 0,
        tax_total: taxTotal || resHistory?.total_tax || 0,
        fees_total: feesTotal || resHistory?.total_fees || 0,
        grand_total: grandTotal || resHistory?.grand_total || 0,
        vehicle_info: vehicle,
        status: "confirmed",
        ...(stripePaymentIntentId && { stripe_payment_intent_id: stripePaymentIntentId }),
      });

      if (bookingError) {
        console.error("Error creating booking:", bookingError);
        // Don't fail the whole request - ResLab reservation was already created
      }
    } catch (supabaseError) {
      // Log but don't fail - ResLab reservation was successful
      console.error("Supabase save error:", supabaseError);
    }

    // Extract location data from reservation history
    const resLocation = resHistory?.location;
    const shuttleDetails = stripHtml(resLocation?.shuttle_info_details ?? null) || undefined;
    const specialConditions = stripHtml(resLocation?.special_conditions ?? null) || undefined;

    // Send confirmation email (don't fail if email fails)
    try {
      const vehicleInfo = `${vehicle.make} ${vehicle.model} (${vehicle.color}) - ${vehicle.licensePlate}`;
      await sendBookingConfirmation({
        to: customer.email,
        customerName: `${customer.firstName} ${customer.lastName}`,
        confirmationNumber: reservation.reservation_number,
        lotName: locationName || resLocation?.name || `Location ${locationId}`,
        lotAddress: locationAddress || resLocation?.address || "",
        checkInDate: fromDate.split(" ")[0], // Extract date part
        checkOutDate: toDate.split(" ")[0],
        totalAmount: resHistory?.grand_total || grandTotal || 0,
        dueAtLocation: resHistory?.due_at_location_total || 0,
        vehicleInfo,
        shuttleDetails,
        specialConditions,
      });
    } catch (emailError) {
      // Log but don't fail - reservation was successful
      console.error("Email send error:", emailError);
    }

    // Send admin notification email (don't fail if email fails)
    try {
      const vehicleInfoStr = `${vehicle.make} ${vehicle.model} (${vehicle.color}) - ${vehicle.licensePlate}`;
      await sendAdminBookingNotification({
        confirmationNumber: reservation.reservation_number,
        customerName: fullName,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        lotName: locationName || resLocation?.name || `Location ${locationId}`,
        lotAddress: locationAddress || resLocation?.address || "",
        checkInDate: fromDate.split(" ")[0],
        checkOutDate: toDate.split(" ")[0],
        totalAmount: resHistory?.grand_total || grandTotal || 0,
        dueAtLocation: resHistory?.due_at_location_total || 0,
        vehicleInfo: vehicleInfoStr,
        airportCode: airportCode || undefined,
      });
    } catch (adminEmailError) {
      console.error("Admin notification email error:", adminEmailError);
    }

    // Build response from history data
    return NextResponse.json({
      success: true,
      reservation: {
        id: resHistory?.id || reservation.reservation_number,
        reservationNumber: reservation.reservation_number,
        status: reservation.cancelled ? "cancelled" : "confirmed",
        grandTotal: resHistory?.grand_total || grandTotal || 0,
        dueNow: (resHistory?.grand_total || 0) - (resHistory?.due_at_location_total || 0),
        dueAtLocation: resHistory?.due_at_location_total || 0,
        customer: {
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          phone: customer.phone,
        },
        items: resHistory?.dates?.map((date) => ({
          type: "parking",
          fromDate: date.from_date,
          toDate: date.to_date,
          numberOfDays: null,
          numberOfSpots: 1,
        })) || [],
        location: resLocation
          ? {
              id: resLocation.id,
              name: resLocation.name,
              address: resLocation.address,
              city: resLocation.city,
              state: resLocation.state?.code,
              zipCode: resLocation.zip_code,
              phone: resLocation.phone,
              shuttleDetails,
              specialConditions,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("Reservation creation error:", error);

    // Sanitize error messages — never expose raw API responses to users
    let userMessage = "Failed to create reservation. Please try again.";

    if (error instanceof ReslabError) {
      // Try to extract a clean message from the ResLab error
      try {
        const parsed = JSON.parse(error.message.replace("API request failed: ", ""));
        if (parsed.message && typeof parsed.message === "string") {
          userMessage = parsed.message;
        }
      } catch {
        // If parsing fails, use status-code-based messages
        if (error.statusCode === 500) {
          userMessage = "This property's system is temporarily unavailable. Please try again later or choose a different property.";
        } else if (error.statusCode === 409) {
          userMessage = "This parking option is no longer available. Please go back and select a different option.";
        }
      }
    }

    return NextResponse.json(
      { error: userMessage },
      { status: 500 }
    );
  }
}
