import { NextRequest, NextResponse } from "next/server";
import { reslab, ReslabError, stripHtml } from "@/lib/reslab/client";
import { createAdminClient } from "@/lib/supabase/server";
import { sendBookingConfirmation } from "@/lib/resend/send-booking-confirmation";
import { sendAdminBookingNotification } from "@/lib/resend/send-admin-booking-notification";
import { reservationSchema } from "@/lib/validation/schemas";
import { stripe } from "@/lib/stripe/client";
import { capturePaymentError, captureParkGuardError, captureBookingError } from "@/lib/sentry";
import { convertTo12Hour } from "@/lib/utils/time";
import {
  parkGuard,
  PROTECTION_PLAN,
  ParkGuardError,
  PARKGUARD_STATUS,
  formatPgDate,
} from "@/lib/parkguard/client";

const DEV_SKIP_PAYMENT =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_DEV_SKIP_PAYMENT === "true";

export async function POST(request: NextRequest) {
  // Hoisted so the outer catch can attach PG/payment Sentry context (the
  // destructured Zod result lives inside the try and isn't in scope below).
  // A throw past the Stripe verification means the customer was already
  // charged — we need this metadata to surface a money-handling event,
  // not just a generic booking error.
  let outerCaptureContext: {
    hasProtectionPlan?: boolean;
    stripePaymentIntentId?: string;
    airportCode?: string;
    reslabReservationNumber?: string;
  } = {};

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
      triplyServiceFee,
      userId,
      stripePaymentIntentId,
      hasProtectionPlan,
    } = result.data;

    outerCaptureContext = {
      hasProtectionPlan,
      stripePaymentIntentId,
      airportCode: airportCode || undefined,
    };

    // Single source of truth for the Park Guard premium across the booking
    // insert, the customer email, the admin email, and the POST response.
    const protectionPremium = hasProtectionPlan ? PROTECTION_PLAN.price : 0;
    // Park Guard identifier — assigned only when the synchronous PG capture
    // below succeeds. Persisted on the booking row and returned in the POST
    // response so admin/ops tooling can surface sync state.
    let pgIdentifier: string | null = null;
    // Final PG sync state at email composition time. Mirrors the value the
    // PG block writes to bookings.pg_sync_status so the booking confirmation
    // email can render the matching variant (Active vs. "Confirming") without
    // a second DB read after the PG block completes.
    let pgSyncStatusLocal:
      | "pending"
      | "synced"
      | "skipped_missing_data"
      | null = null;

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

        // safety-removed: previously required status === "succeeded". We use
        // Stripe async capture (automatic_async), so a genuinely-paying customer
        // can reach here with status "processing" (money authorized, capture in
        // flight). Rejecting it with 402 was the server half of the
        // double-charge/orphan bug: the client (stripe-payment-form) now creates
        // the reservation on "processing" too, and this guard must accept it or
        // the booking still fails. Still rejects genuinely-unpaid states
        // (requires_payment_method, requires_action, canceled). The rare
        // processing→payment_failed case is NOT yet auto-released — the webhook
        // flips status to payment_failed and alerts Sentry; automated
        // ResLab/Park Guard release is a pending Phase 2 enhancement.
        if (paymentIntent.status !== "succeeded" && paymentIntent.status !== "processing") {
          capturePaymentError(
            new Error(`PaymentIntent status is ${paymentIntent.status}, expected succeeded or processing`),
            { stripePaymentIntentId, amount: paymentIntent.amount / 100 }
          );
          return NextResponse.json(
            { error: "Payment has not been completed" },
            { status: 402 }
          );
        }

        // Cross-check protection-plan flag against the PaymentIntent metadata.
        // The Stripe charge amount was determined by /api/checkout/lot POST,
        // which writes `protectionPlanPrice` into PI metadata when the customer
        // opted in. If this request's `hasProtectionPlan` disagrees with the PI
        // metadata, the client tampered (or there's a bug) — refuse so we don't
        // record a booking with a different protection status than what Stripe
        // actually charged for.
        const piProtectionPriceStr = paymentIntent.metadata?.protectionPlanPrice;
        const piHasProtection =
          !!piProtectionPriceStr && parseFloat(piProtectionPriceStr) > 0;
        if (piHasProtection !== !!hasProtectionPlan) {
          capturePaymentError(
            new Error(
              `hasProtectionPlan mismatch: request=${!!hasProtectionPlan}, PaymentIntent metadata=${piHasProtection}`
            ),
            { stripePaymentIntentId, amount: paymentIntent.amount / 100 }
          );
          return NextResponse.json(
            { error: "Payment verification failed" },
            { status: 400 }
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

    outerCaptureContext.reslabReservationNumber = reservation.reservation_number;

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
      const { data: bookingRow, error: bookingError } = await supabase
        .from("bookings")
        .insert({
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
          // grand_total stores the parking total (ResLab-side amount). The
          // protection premium lives in `protection_plan_price` so reporting
          // queries can read each independently. Display code composes
          // grand_total + service_fee + (protection_plan_price ?? 0).
          //
          // ResLab's value is preferred over the client-supplied `grandTotal`
          // because ResLab is the source of truth for parking revenue; the
          // client value is only a fallback if ResLab didn't echo it back.
          grand_total: resHistory?.grand_total ?? grandTotal ?? 0,
          triply_service_fee: triplyServiceFee || 0,
          due_at_location: resHistory?.due_at_location_total || 0,
          vehicle_info: vehicle,
          status: "confirmed",
          ...(stripePaymentIntentId && { stripe_payment_intent_id: stripePaymentIntentId }),
          ...(hasProtectionPlan && {
            protection_plan: PROTECTION_PLAN.name,
            protection_plan_price: PROTECTION_PLAN.price,
          }),
        })
        .select("id")
        .single();

      if (bookingError) {
        console.error("Error creating booking:", bookingError);
        // Don't fail the whole request — ResLab reservation was already
        // created. But the customer paid for parking (and possibly protection),
        // so we have a money-handling event with no Supabase row. Surface it
        // loudly so finance + ops can manually reconcile.
        captureBookingError(
          new Error(`Booking insert failed: ${bookingError.message}`),
          { step: "checkout", airportCode }
        );
        if (hasProtectionPlan) {
          const ctxErr = new Error(
            `Booking insert failed for protection-opted reservation; customer charged for premium but Park Guard not enrolled: ${bookingError.message}`
          );
          captureParkGuardError(ctxErr, {
            reslabReservationNumber: reservation.reservation_number,
            operation: "capture",
          });
          // capturePaymentError is gated on stripePaymentIntentId because
          // DEV_SKIP_PAYMENT mode never charges; no payment to capture.
          if (stripePaymentIntentId) {
            capturePaymentError(ctxErr, {
              stripePaymentIntentId,
              amount: PROTECTION_PLAN.price,
            });
          }
        }
      }

      // Forward to Park Guard if customer opted in. Non-blocking — Park Guard
      // outage shouldn't fail the booking, but we record the failure to Sentry
      // for background reconciliation.
      if (hasProtectionPlan && bookingRow?.id) {
        try {
          const [startDate, startTime24] = fromDate.split(" ");
          const [endDate, endTime24] = toDate.split(" ");
          // Local components, not toISOString — Vercel runs UTC so toISOString
          // would shift late-evening ET bookings to the next day's date.
          const todayDate = formatPgDate(new Date());
          const pgLocation = resHistory?.location;

          // PG requires street/city/state/zipcode. Fall back through ResLab's
          // structured location to the flat `locationAddress` only as a last
          // resort. If anything is still missing, skip the POST and surface a
          // distinct Sentry alert — empty strings would 422 on PG's side and
          // become indistinguishable from a real outage.
          const pgStreet = pgLocation?.address || locationAddress;
          const pgCity = pgLocation?.city;
          const pgState = pgLocation?.state?.code;
          const pgZip = pgLocation?.zip_code;
          if (!pgStreet || !pgCity || !pgState || !pgZip) {
            // Distinct sentinel statusCode so Sentry alerts + reconciliation
            // jobs can tell this PERMANENT skip apart from a transient outage.
            // The reconciler should ignore MISSING_DATA rows; ops fixes the
            // underlying lot data.
            captureParkGuardError(
              new Error(
                `Park Guard capture skipped — required address fields missing: street=${!!pgStreet}, city=${!!pgCity}, state=${!!pgState}, zip=${!!pgZip}`
              ),
              {
                bookingId: bookingRow.id,
                reslabReservationNumber: reservation.reservation_number,
                operation: "capture",
                statusCode: PARKGUARD_STATUS.MISSING_DATA,
              }
            );
            // Persist the permanent-skip state so reconciliation jobs ignore
            // this row and admin UI can render distinct copy. If this update
            // fails, the row is left with pg_sync_status NULL and would be
            // picked up by the reconciliation index forever — surface to
            // Sentry so ops sees both failures together.
            const { error: skipUpdateErr } = await supabase
              .from("bookings")
              .update({ pg_sync_status: "skipped_missing_data" })
              .eq("id", bookingRow.id);
            pgSyncStatusLocal = "skipped_missing_data";
            if (skipUpdateErr) {
              captureParkGuardError(
                new Error(
                  `Failed to persist 'skipped_missing_data' status: ${skipUpdateErr.message}`
                ),
                {
                  bookingId: bookingRow.id,
                  reslabReservationNumber: reservation.reservation_number,
                  operation: "update",
                }
              );
            }
          } else {
          const pgRes = await parkGuard.captureReservation({
            reservation_id: bookingRow.id,
            reservation_start_date: startDate,
            reservation_end_date: endDate,
            booking_date: todayDate,
            parking_street_address: pgStreet,
            parking_city: pgCity,
            parking_state: pgState,
            parking_zipcode: pgZip,
            // PG expects "Plan A"/"Plan B"/"Plan C" codes — not the display
            // name. We store the display name in `bookings.protection_plan`
            // for customer surfaces; translate at the API boundary here.
            protection_plan: PROTECTION_PLAN.pgPlanCode,
            protection_plan_price: PROTECTION_PLAN.price,
            email: customer.email,
            first_name: customer.firstName,
            last_name: customer.lastName,
            phone_number: customer.phone,
            reservation_start_time: startTime24,
            reservation_end_time: endTime24,
            car_make: vehicle.make,
            car_model: vehicle.model,
            booking_site: new URL(
              process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com"
            ).host,
          });

          // Park Guard returned the identifier; if our local update fails,
          // the customer is enrolled but our row stays "Pending sync" and
          // background reconciliation would re-POST a duplicate. Capture
          // the identifier in Sentry extras so reconciliation picks it up
          // from there instead of re-POSTing.
          const { error: pgUpdateError } = await supabase
            .from("bookings")
            .update({
              pg_identifier: pgRes.pg_identifier,
              pg_sync_status: "synced",
            })
            .eq("id", bookingRow.id);

          // pgIdentifier is set off PG's response — useful for the POST
          // response and admin tooling even if the local DB write below
          // failed. pgSyncStatusLocal, in contrast, drives the customer
          // email's protection callout copy; it must mirror what landed
          // in the DB row so the email and the (DB-backed) confirmation
          // page agree. If the local update failed, leave it null so both
          // surfaces render "Confirming" until ops repairs the row.
          pgIdentifier = pgRes.pg_identifier;
          if (!pgUpdateError) {
            pgSyncStatusLocal = "synced";
          }

          if (pgUpdateError) {
            // 23505 = Postgres unique_violation. Hits when migration 009's
            // UNIQUE(pg_identifier) catches a duplicate write — usually a
            // reconciliation job racing with this path. Operationally
            // very different from a generic write failure, so flag distinctly.
            const isDuplicate =
              (pgUpdateError as { code?: string }).code === "23505";
            captureParkGuardError(
              new Error(
                `Park Guard captured but local pg_identifier update failed${
                  isDuplicate ? " (duplicate — pg_identifier already on another row)" : ""
                }: ${pgUpdateError.message}`
              ),
              {
                bookingId: bookingRow.id,
                reslabReservationNumber: reservation.reservation_number,
                operation: "update",
                // Structured field so ops can recover the identifier
                // programmatically rather than scraping the error message.
                pgIdentifier: pgRes.pg_identifier,
              }
            );
          }
          }
        } catch (pgError) {
          captureParkGuardError(
            pgError instanceof Error ? pgError : new Error(String(pgError)),
            {
              bookingId: bookingRow.id,
              reslabReservationNumber: reservation.reservation_number,
              operation: "capture",
              ...(pgError instanceof ParkGuardError && { statusCode: pgError.statusCode }),
            }
          );
        }
      }
    } catch (supabaseError) {
      // Log but don't fail - ResLab reservation was successful, but the
      // customer paid and we have no row. Surface to Sentry — same money-
      // handling rationale as the bookingError branch.
      console.error("Supabase save error:", supabaseError);
      const sbErr =
        supabaseError instanceof Error ? supabaseError : new Error(String(supabaseError));
      captureBookingError(sbErr, { step: "checkout", airportCode });
      // If the customer paid for Park Guard, fire the additional money-event
      // captures so finance/ops can reconcile: PG was never enrolled, and
      // the protection-premium charge has no booking row.
      if (hasProtectionPlan) {
        const ctxErr = new Error(
          `Supabase save failed for protection-opted reservation; customer charged for premium but Park Guard not enrolled: ${sbErr.message}`
        );
        captureParkGuardError(ctxErr, {
          reslabReservationNumber: reservation.reservation_number,
          operation: "capture",
        });
        if (stripePaymentIntentId) {
          capturePaymentError(ctxErr, {
            stripePaymentIntentId,
            amount: PROTECTION_PLAN.price,
          });
        }
      }
    }

    // Extract location data from reservation history
    const resLocation = resHistory?.location;
    const shuttleDetails = stripHtml(resLocation?.shuttle_info_details ?? null) || undefined;
    const specialConditions = stripHtml(resLocation?.special_conditions ?? null) || undefined;

    // Send confirmation email (don't fail if email fails)
    try {
      const vehicleInfo = `${vehicle.make} ${vehicle.model} (${vehicle.color}) - ${vehicle.licensePlate}`;
      const [checkInDate, checkInTime24] = fromDate.split(" ");
      const [checkOutDate, checkOutTime24] = toDate.split(" ");
      await sendBookingConfirmation({
        to: customer.email,
        customerName: `${customer.firstName} ${customer.lastName}`,
        confirmationNumber: reservation.reservation_number,
        lotName: locationName || resLocation?.name || `Location ${locationId}`,
        lotAddress: locationAddress || resLocation?.address || "",
        checkInDate,
        checkOutDate,
        checkInTime: convertTo12Hour(checkInTime24),
        checkOutTime: convertTo12Hour(checkOutTime24),
        totalAmount:
          (resHistory?.grand_total ?? grandTotal ?? 0) +
          (triplyServiceFee || 0) +
          protectionPremium,
        dueAtLocation: resHistory?.due_at_location_total || 0,
        vehicleInfo,
        shuttleDetails,
        specialConditions,
        ...(hasProtectionPlan && {
          protectionPlan: PROTECTION_PLAN.name,
          protectionPlanPrice: PROTECTION_PLAN.price,
        }),
        // Forward sync state independent of hasProtectionPlan so a future
        // caller that composes from a stored row (resend tool, etc.) can't
        // accidentally drop the signal and have the email default to the
        // wrong variant. The template's `isProtectionConfirmed` gate is
        // already conjunctive on (protectionPlan + price + status === synced),
        // so passing pgSyncStatus when no plan is set is harmless.
        pgSyncStatus: pgSyncStatusLocal,
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
        totalAmount:
          (resHistory?.grand_total ?? grandTotal ?? 0) +
          (triplyServiceFee || 0) +
          protectionPremium,
        dueAtLocation: resHistory?.due_at_location_total || 0,
        vehicleInfo: vehicleInfoStr,
        airportCode: airportCode || undefined,
        ...(hasProtectionPlan && {
          protectionPlan: PROTECTION_PLAN.name,
          protectionPlanPrice: PROTECTION_PLAN.price,
        }),
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
        grandTotal:
          (resHistory?.grand_total ?? grandTotal ?? 0) +
          (triplyServiceFee || 0) +
          protectionPremium,
        serviceFee: triplyServiceFee || 0,
        protectionPlan: hasProtectionPlan ? PROTECTION_PLAN.name : null,
        protectionPlanPrice: protectionPremium,
        // pgIdentifier is set when the synchronous Park Guard capture above
        // succeeded; null means the customer paid the premium but PG hasn't
        // acknowledged (transient outage or skipped due to missing data).
        pgIdentifier,
        dueNow:
          (resHistory?.grand_total || 0) +
          (triplyServiceFee || 0) +
          protectionPremium -
          (resHistory?.due_at_location_total || 0),
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

    // The Stripe verification at the top of POST runs FIRST, so by the time
    // we reach this outer catch the customer was already charged. Anything
    // throwing here (ResLab failure, malformed input that slipped past Zod,
    // etc.) is a money-handling event with no booking row, no PG enrollment,
    // and a 500 to the client — must be Sentry-captured for ops triage.
    const wrapped = error instanceof Error ? error : new Error(String(error));
    captureBookingError(wrapped, {
      step: "checkout",
      airportCode: outerCaptureContext.airportCode,
    });
    if (outerCaptureContext.hasProtectionPlan) {
      const ctxErr = new Error(
        `Reservation flow failed for protection-opted booking; customer charged for premium but Park Guard not enrolled: ${wrapped.message}`
      );
      captureParkGuardError(ctxErr, {
        ...(outerCaptureContext.reslabReservationNumber && {
          reslabReservationNumber: outerCaptureContext.reslabReservationNumber,
        }),
        operation: "capture",
      });
      if (outerCaptureContext.stripePaymentIntentId) {
        capturePaymentError(ctxErr, {
          stripePaymentIntentId: outerCaptureContext.stripePaymentIntentId,
          amount: PROTECTION_PLAN.price,
        });
      }
    }

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
