import { NextRequest, NextResponse } from "next/server";
import { reslab } from "@/lib/reslab/client";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { captureBookingError } from "@/lib/sentry";
import { isAdminEmail } from "@/config/admin";
import { cancelSource } from "@/lib/cancellation/source-guard";
import { buildDirectReservation, type GuestContact } from "@/lib/direct/reservation-view";
import { buildCostBreakdown, fallbackDue, type CostBreakdownResult } from "@/lib/booking/cost-breakdown";
import {
  cardSummary,
  describeFallback,
  expectedPromoCents,
  protectionPlanName,
} from "@/lib/booking/confirmation-payment";
import { readCardPayment, reportCostBreakdownFallback } from "@/lib/booking/read-card-payment";
import { billedParkingDays } from "@/lib/reslab/billed-days";

/**
 * The guest as typed at checkout, for a direct booking's confirmation page: the
 * name / email / phone the confirmation was sent to. Bounded and never fatal — a
 * failed read falls back to the linked customers row (reported, because that
 * row can be the signed-in ACCOUNT's details rather than the guest's).
 */
type StagedGuestRead = { ok: true; guest: GuestContact | null } | { ok: false };

async function readStagedGuestResult(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  paymentIntentId: string | null | undefined,
  confirmationNumber: string
): Promise<StagedGuestRead> {
  if (!paymentIntentId) return { ok: true, guest: null };
  try {
    const { data, error } = await supabase
      .from("pending_bookings")
      .select("customer")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .abortSignal(AbortSignal.timeout(3_000))
      .maybeSingle();
    if (error) throw new Error(error.message);
    const c = (data as { customer?: unknown } | null)?.customer;
    if (!c || typeof c !== "object") return { ok: true, guest: null };
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const r = c as Record<string, unknown>;
    return { ok: true, guest: { firstName: str(r.firstName), lastName: str(r.lastName), email: str(r.email), phone: str(r.phone) } };
  } catch (err) {
    captureBookingError(
      new Error(`staged guest read failed: ${err instanceof Error ? err.message : String(err)}`),
      { step: "confirmation", confirmationNumber, fingerprint: ["staged-guest-read-failed"] }
    );
    return { ok: false };
  }
}

/**
 * For a DIRECT booking's page: a failed read falls back to the linked customers
 * row (reported above). A direct booking always has a staged row with an email
 * (staged and Zod-checked before payment, never deleted), so a missing one is
 * reported too — the fallback can be the signed-in ACCOUNT's details.
 */
async function readStagedGuest(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  paymentIntentId: string | null | undefined,
  confirmationNumber: string
): Promise<GuestContact | null> {
  const r = await readStagedGuestResult(supabase, paymentIntentId, confirmationNumber);
  if (!r.ok) return null;
  if (!r.guest?.email?.trim()) {
    captureBookingError(
      new Error("direct booking: staged guest missing or has no email — the page shows the linked customer row"),
      { step: "confirmation", confirmationNumber, fingerprint: ["direct-staged-guest-missing"] }
    );
  }
  return r.guest;
}

const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

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
    // Set when access was granted ONLY through the staged (typed-at-checkout)
    // email: the viewer is the guest, not the account holder, so the page must
    // show exactly this guest and never fall back to the account's customers row.
    let guestViaStaged: GuestContact | null = null;

    // --- Auth check (R1: IDOR protection) ---
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      // Logged-in user: verify they own this booking. Ownership is either the
      // user_id link OR — because that link is unreliably populated — a match
      // between the booking's customer email and the user's VERIFIED account
      // email (same trust model as the guest branch below). Without this
      // fallthrough a signed-in customer 403s on their own booking whenever the
      // user_id link was never set (guest checkout, later signup, etc.).
      const adminClient = await createAdminClient();
      const { data: booking, error: bookingLookupErr } = await adminClient
        .from("bookings")
        .select("customer_id, stripe_payment_intent_id, customers(user_id, email)")
        .eq("reslab_reservation_number", id)
        .maybeSingle();

      // A DB error must not become a 403 — that would tell the legitimate owner
      // "not your booking" on a transient failure.
      if (bookingLookupErr) {
        captureBookingError(
          new Error(`booking ownership lookup failed: ${bookingLookupErr.message}`),
          { step: "confirmation", confirmationNumber: id }
        );
        return NextResponse.json(
          { error: "Unable to verify reservation. Please try again." },
          { status: 500 }
        );
      }

      const customer = (booking?.customers ?? null) as
        | { user_id?: string | null; email?: string | null }
        | null;
      const ownsByUserId = !!customer?.user_id && customer.user_id === user.id;
      // Email-based ownership is gated on the same kill-switch as the other
      // email-fallback surfaces (/api/user/bookings, /api/user/link-bookings)
      // so ENABLE_EMAIL_BOOKING_FALLBACK=false halts ALL email-based booking
      // access — including this highest-PII detail surface — in one env flip.
      const fallbackEnabled =
        process.env.ENABLE_EMAIL_BOOKING_FALLBACK !== "false";
      const verifiedEmail = fallbackEnabled && !!user.email_confirmed_at ? user.email : null;
      let ownsByEmail = !!verifiedEmail && sameEmail(customer?.email, verifiedEmail);
      // A booking a signed-in customer made FOR someone else is filed under the
      // booker's customers row, while the confirmation went to the address typed
      // at checkout — the recipient (signed in with that verified address) owns it too.
      // Admins see every booking: work that out first, so an admin never waits on
      // (or is failed by) a staged read whose answer can't change the outcome.
      const isAdmin = isAdminEmail(user.email);
      if (booking && !ownsByUserId && !ownsByEmail && verifiedEmail && !isAdmin) {
        const staged = await readStagedGuestResult(
          adminClient,
          (booking as { stripe_payment_intent_id?: string | null }).stripe_payment_intent_id,
          id
        );
        if (!staged.ok) {
          return NextResponse.json({ error: "Unable to verify reservation. Please try again." }, { status: 500 });
        }
        ownsByEmail = sameEmail(staged.guest?.email, verifiedEmail);
        if (ownsByEmail) guestViaStaged = staged.guest;
      }

      if (!booking || (!ownsByUserId && !ownsByEmail)) {
        if (!isAdmin) {
          return NextResponse.json(
            { error: "Not authorized to view this reservation" },
            { status: 403 }
          );
        }
      }
    } else {
      // Not logged in: require email query param for verification
      const email = request.nextUrl.searchParams.get("email");
      if (!email) {
        return NextResponse.json(
          { error: "Authentication required" },
          { status: 403 }
        );
      }

      // Look up booking in Supabase to verify email matches
      const adminClient = await createAdminClient();
      const { data: booking, error: bookingLookupErr } = await adminClient
        .from("bookings")
        .select("customer_id, stripe_payment_intent_id, customers(email)")
        .eq("reslab_reservation_number", id)
        .maybeSingle();

      if (bookingLookupErr) {
        captureBookingError(
          new Error(`booking email lookup failed: ${bookingLookupErr.message}`),
          { step: "confirmation", confirmationNumber: id }
        );
        return NextResponse.json(
          { error: "Unable to verify reservation. Please try again." },
          { status: 500 }
        );
      }

      const customerEmail = (
        (booking?.customers ?? null) as { email?: string | null } | null
      )?.email;
      // The email's "View booking" link carries the address typed at checkout.
      // When a signed-in customer booked for someone else, the booking is filed
      // under the booker's customers row, so also accept the typed address — the
      // one the confirmation number was emailed to (same proof: number + inbox).
      let emailMatches = sameEmail(customerEmail, email);
      if (booking && !emailMatches) {
        const staged = await readStagedGuestResult(
          adminClient,
          (booking as { stripe_payment_intent_id?: string | null }).stripe_payment_intent_id,
          id
        );
        if (!staged.ok) {
          return NextResponse.json({ error: "Unable to verify reservation. Please try again." }, { status: 500 });
        }
        emailMatches = sameEmail(staged.guest?.email, email);
        if (emailMatches) guestViaStaged = staged.guest;
      }
      if (!booking || !emailMatches) {
        return NextResponse.json(
          { error: "Not authorized to view this reservation" },
          { status: 403 }
        );
      }
    }

    // Fetch booking record from Supabase. We pull check_in/check_out here as a
    // primary source for booking times — ResLab's getReservation API has been
    // observed returning normalized midnight values for parking_rates.from_date
    // even when the original booking had a real time (e.g., FVSPF765362 returns
    // "00:00:00" via API while the ResLab dashboard shows the correct 08:00 AM).
    // Supabase preserves what the customer originally picked, so it's authoritative.
    //
    // The direct-lot columns (inventory_source … customers) are read so a
    // DIRECT booking (plan 4b §2.2) can be answered from this row alone — it
    // has no ResLab record. They are NULL / unused on ResLab rows.
    const adminClientForVehicle = await createAdminClient();
    const { data: bookingData, error: bookingErr } = await adminClientForVehicle
      .from("bookings")
      .select(`
        vehicle_info, triply_service_fee, check_in, check_out, protection_plan, protection_plan_code, protection_plan_price, pg_identifier, pg_sync_status, airport_code,
        inventory_source, direct_lot_id, lot_snapshot, vehicle_size, vehicle_size_label, vehicle_surcharge_cents, vehicle_surcharge_tax_cents,
        status, subtotal, tax_total, fees_total, grand_total, discount_amount, promo_code, due_at_location, cancel_state,
        stripe_payment_intent_id,
        customers(first_name, last_name, email, phone)
      `)
      .eq("reslab_reservation_number", id)
      .single();

    if (bookingErr) {
      // The auth check above already proved a booking row exists for this id —
      // a failure here is anomalous and would silently re-introduce the original
      // midnight-time bug if we just fell through to ResLab. Surface it.
      captureBookingError(
        new Error(`Supabase booking lookup failed: ${bookingErr.message}`),
        { step: "confirmation", confirmationNumber: id }
      );
    }

    // Normalize Supabase timestamp (TIMESTAMP without tz, returned as
    // "2026-05-10T08:00:00") to the "YYYY-MM-DD HH:mm:ss" shape consumers expect.
    const normalizeBookingDate = (value: string | null | undefined): string | null => {
      if (!value) return null;
      // Strip optional trailing fractional seconds + Z, then optional offset,
      // then convert T to space. Anchored to end-of-string to avoid eating
      // any digit run earlier in the value.
      const trimmed = value
        .replace(/\.\d+Z?$/, "")
        .replace(/Z$|[+-]\d{2}:?\d{2}$/, "");
      return trimmed.replace("T", " ");
    };
    const supabaseFromDate = normalizeBookingDate(bookingData?.check_in);
    const supabaseToDate = normalizeBookingDate(bookingData?.check_out);

    // Which system holds this booking (plan 4b §9 H-C, same strict polarity as
    // cancellation): DIRECT only when the row says `direct` AND the number is
    // our own TRP-; a ResLab number on a row that says reslab — or whose read
    // failed (inventory_source undefined) — takes the ResLab path exactly as
    // before; any disagreement is refused, never guessed.
    const source = cancelSource({
      inventory_source: bookingData?.inventory_source,
      reslab_reservation_number: id,
    });

    if (source.kind !== "reslab") {
      // A TRP- number never goes to ResLab (it would 404 there and tell the
      // customer their booking doesn't exist). Keep a missing row (404) apart
      // from a failed read (500) — the failed read was captured above.
      if (bookingErr) {
        return bookingErr.code === "PGRST116"
          ? NextResponse.json({ error: "Reservation not found" }, { status: 404 })
          : NextResponse.json({ error: "Failed to fetch reservation" }, { status: 500 });
      }
      if (source.kind === "inconsistent") {
        captureBookingError(
          new Error(`reservation source inconsistent: ${source.detail}`),
          { step: "confirmation", confirmationNumber: id }
        );
        return NextResponse.json({ error: "Failed to fetch reservation" }, { status: 500 });
      }

      // The service fee and Park Guard premium are parsed from the row by the
      // direct view itself, strictly (a NULL fee or a plan without a positive
      // premium is a 500), never the lenient ResLab-path coercion below.
      // The Payment summary's anchor: what Stripe actually took (plan
      // 2026-10-12 §2). Never throws; an unknown charge → the plain fallback.
      const payment = await readCardPayment(bookingData?.stripe_payment_intent_id);
      // A guest let in by the staged email gets the guest already read (no second
      // read that could fail over to the ACCOUNT holder's details); the account
      // holder or an admin may fall back to the customers row.
      const guest = guestViaStaged ?? (await readStagedGuest(adminClientForVehicle, bookingData?.stripe_payment_intent_id, id));
      const direct = buildDirectReservation(id, bookingData, {
        pgIdentifier: bookingData?.pg_identifier || null,
        pgSyncStatus: bookingData?.pg_sync_status || null,
        fromDate: supabaseFromDate,
        toDate: supabaseToDate,
        payment,
        guest,
      });
      if (!direct.ok) {
        captureBookingError(
          new Error(`direct booking view failed: ${direct.detail}`),
          { step: "confirmation", confirmationNumber: id }
        );
        return NextResponse.json({ error: "Failed to fetch reservation" }, { status: 500 });
      }
      if (!direct.reservation.costBreakdown.ok) {
        const { report } = describeFallback({
          rowReadFailed: false,
          payment,
          cancelled: direct.reservation.status === "cancelled",
          coreReason: direct.reservation.costBreakdown.reason,
        });
        if (report) {
          reportCostBreakdownFallback(id, report, {
            inventorySource: "direct",
            stripePaymentIntentId: bookingData?.stripe_payment_intent_id,
          });
        }
      }
      return NextResponse.json({ reservation: direct.reservation });
    }

    // --- ResLab booking (behaviour unchanged) ---
    const triplyServiceFee = parseFloat(bookingData?.triply_service_fee ?? "0") || 0;

    // Resolve protection state defensively. If protection_plan is set, the row
    // MUST also have a positive protection_plan_price — anything else is a
    // schema-level bug that would render "Protection Active … $0.00" to the
    // customer. Suppress the protection block in that case and Sentry-flag so
    // ops can manually repair.
    let resolvedProtectionPlan: string | null = bookingData?.protection_plan || null;
    let resolvedProtectionPlanPrice = 0;
    if (resolvedProtectionPlan) {
      const parsed = parseFloat(bookingData?.protection_plan_price ?? "");
      if (Number.isFinite(parsed) && parsed > 0) {
        resolvedProtectionPlanPrice = parsed;
      } else {
        captureBookingError(
          new Error(
            `Booking has protection_plan='${resolvedProtectionPlan}' but invalid protection_plan_price='${bookingData?.protection_plan_price}' — suppressing protection block in API response`
          ),
          { step: "confirmation", confirmationNumber: id }
        );
        resolvedProtectionPlan = null;
      }
    }
    const protectionPlanPrice = resolvedProtectionPlanPrice;

    // Fetch reservation from ResLab API — and, alongside it, what Stripe took
    // on the booking's PaymentIntent (the Payment summary's anchor; never
    // throws, bounded). A failed row read has no PaymentIntent id → unknown.
    const [reservation, payment] = await Promise.all([
      reslab.getReservation(id),
      readCardPayment(bookingData?.stripe_payment_intent_id),
    ]);

    // ResLab returns data nested in history[0]
    const history = reservation.history?.[0];
    const location = history?.location;

    // Cancelled if EITHER side says so. Our row is cancelled/refunded only by a
    // cancel or a full refund, and two shipped paths write it while ResLab's
    // flag stays 0: an admin cancel whose ResLab call failed, and a full refund
    // made in the Stripe dashboard. That customer has been refunded — the page
    // must not show them "Booking Confirmed!" and a QR code. A failed row read
    // (bookingData undefined) falls back to ResLab's flag alone, as before.
    const reslabCancelled = Boolean(reservation.cancelled);
    const rowCancelled = bookingData?.status === "cancelled" || bookingData?.status === "refunded";
    if (rowCancelled && !reslabCancelled) {
      // The lot still holds a spot we refunded (and ResLab may bill us for it) —
      // OR a full goodwill / duplicate-charge refund flipped the row while the
      // customer still means to park. Ops must decide which before acting.
      captureBookingError(
        new Error(`Booking ${id} is ${bookingData?.status} in our database but still live in ResLab — if it was meant to be cancelled, release the ResLab reservation; if not, set the row back to confirmed`),
        { step: "confirmation", confirmationNumber: id }
      );
    } else if (reslabCancelled && bookingData?.status === "confirmed" && !bookingData?.cancel_state) {
      // Cancelled on ResLab's side (the lot, or the ResLab dashboard) with no
      // cancel of ours in flight: the customer now sees "Booking Cancelled" but
      // nothing has refunded them. (Our own cancels pass through this state for
      // a moment, but both claim the row first — cancel_state 'claimed' /
      // 'admin_claimed' — before their ResLab call, so they're skipped.)
      captureBookingError(
        new Error(`Booking ${id} is cancelled in ResLab but confirmed in our database — check whether the customer is owed a refund`),
        { step: "confirmation", confirmationNumber: id }
      );
    }

    // Parse customer name from reserved_for
    const reservedFor = history?.reserved_for || reservation.reserved_by || "";
    const nameParts = reservedFor.split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    // Get dates from the first item in history
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dates = history?.dates?.[0] as any;
    // First rate line: spot count and parking type only. A stay can span several
    // lines (one per rate period) — the day count sums them (billedParkingDays).
    const parkingRates = dates?.parking_rates?.[0];

    // --- Payment summary (plan notes/2026-10-12-cost-breakdown-plan.md) ---
    // Built from ResLab's history + the row + Stripe, ALL sums in
    // buildCostBreakdown. Every input we could not read is passed as null so
    // the breakdown is refused (ok:false → plain fallback) — never a $0 line:
    // a failed row read (fee / discount / plan unknown), a plan whose premium
    // is unreadable (suppressed above), a NULL fee on a legacy row, a Stripe
    // read that failed or a PaymentIntent that isn't settled.
    const rowRead = bookingData ?? null;
    const rowPlan: string | null = rowRead ? rowRead.protection_plan || null : null;
    const billedDays = billedParkingDays(dates);
    const cancelled = reslabCancelled || rowCancelled;
    // Guarded: ResLab's history is untyped JSON. Whatever it holds, a throw
    // in the breakdown becomes a refused breakdown (its own reason class, the
    // original exception to Sentry) — never a 500 for the whole page.
    let built: CostBreakdownResult;
    let breakdownError: unknown = null;
    try {
    built = buildCostBreakdown({
      source: "reslab",
      days: billedDays,
      subtotal: history?.subtotal,
      fees: history?.total_fees,
      longTermDiscount: history?.long_term_discount,
      tax: history?.total_tax,
      grandTotal: history?.grand_total,
      // As read: a missing due-at-location is unknown, never "nothing due".
      dueAtLocation: history?.due_at_location_total,
      storedGrandTotal: rowRead ? rowRead.grand_total : null,
      serviceFee: rowRead ? rowRead.triply_service_fee : null,
      promoDiscount: rowRead ? (rowRead.discount_amount ?? 0) : null,
      promoCode: rowRead?.promo_code || null,
      // The code's percent (stamped on the PaymentIntent by checkout) on the
      // base checkout used: ResLab's sub_total (/api/checkout/lot).
      expectedPromoCents: rowRead
        ? expectedPromoCents({
            discountPercent: payment.discountPercent,
            base: history?.subtotal,
          })
        : null,
      protection: rowPlan
        ? { name: protectionPlanName(rowRead?.protection_plan_code, rowPlan), premium: rowRead?.protection_plan_price }
        : null,
      anchorChargedCents: payment.ok ? payment.chargedCents : null,
      refundedCents: payment.ok ? payment.refundedCents : 0,
      cancelled,
    });
    } catch (error) {
      breakdownError = error;
      built = { ok: false, reason: "breakdown threw" };
    }
    let costBreakdown: CostBreakdownResult = built;
    if (breakdownError !== null) {
      costBreakdown = { ok: false, reason: "breakdown threw" };
      reportCostBreakdownFallback(
        id,
        { reasonClass: "breakdown_threw", reason: "breakdown threw", level: "error" },
        { inventorySource: "reslab", stripePaymentIntentId: rowRead?.stripe_payment_intent_id },
        breakdownError
      );
    } else if (!built.ok) {
      const { reason, report } = describeFallback({
        rowReadFailed: !rowRead,
        payment,
        cancelled,
        coreReason: built.reason,
      });
      costBreakdown = { ok: false, reason };
      if (report) {
        reportCostBreakdownFallback(id, report, {
          inventorySource: "reslab",
          stripePaymentIntentId: rowRead?.stripe_payment_intent_id,
        });
      }
    }
    // The fallback's card side: Stripe's own amount (+ refunds), a released
    // hold, or unknown — never an amount computed from the row and called
    // "charged".
    const cardPayment = cardSummary(payment);
    // What the fallback may say is due at the location (core rule): ResLab's
    // figure as read — a missing one, one above the grand total, or a $0 whose
    // split the refusal puts in doubt is "unconfirmed", never silently 0.
    const dueForFallback = fallbackDue({
      source: "reslab",
      recordedDue: history?.due_at_location_total,
      grandTotal: history?.grand_total,
      parts: {
        subtotal: history?.subtotal,
        fees: history?.total_fees,
        longTermDiscount: history?.long_term_discount ?? 0,
        tax: history?.total_tax,
      },
      refusal: built.ok ? null : built.reason,
      cancelled,
    });

    return NextResponse.json({
      reservation: {
        id: history?.id || reservation.reservation_number,
        reservationNumber: reservation.reservation_number,
        inventorySource: "reslab",
        status: cancelled ? "cancelled" : "confirmed",
        grandTotal: (history?.grand_total || 0) + triplyServiceFee + protectionPlanPrice,
        subtotal: history?.subtotal || 0,
        taxTotal: history?.total_tax || 0,
        feesTotal: history?.total_fees || 0,
        serviceFee: triplyServiceFee,
        protectionPlan: resolvedProtectionPlan,
        protectionPlanPrice,
        pgIdentifier: bookingData?.pg_identifier || null,
        pgSyncStatus: bookingData?.pg_sync_status || null,
        // The booking's airport (e.g. "JFK") for the GA4 purchase event — the
        // lot id can't supply it ("reslab-<n>"). From Vin's PR #72.
        airportCode: bookingData?.airport_code || null,
        dueNow: (history?.grand_total || 0) + triplyServiceFee + protectionPlanPrice - (history?.due_at_location_total || 0),
        dueAtLocation: history?.due_at_location_total || 0,
        costBreakdown,
        cardPayment,
        fallbackDue: dueForFallback,
        customer: {
          firstName,
          lastName,
          email: history?.email || "",
          phone: history?.phone || "",
        },
        items: dates ? [{
          type: "parking",
          // Prefer Supabase values for times — ResLab's API can return midnight
          // even when the dashboard shows the correct picked time. Then the
          // block's own dates (the whole stay), never the first rate line's,
          // which ends where the first rate period does.
          fromDate: supabaseFromDate || dates.from_date || parkingRates?.from_date,
          toDate: supabaseToDate || dates.to_date || parkingRates?.to_date,
          numberOfDays: billedDays ?? undefined,
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
        // Vehicle info from Supabase (reliable), with ResLab extra_fields as fallback
        vehicleInfo: bookingData?.vehicle_info || null,
        extraFields: Array.isArray(history?.extra_fields)
          ? Object.fromEntries(
              history.extra_fields
                .filter((f) => f.name && f.value)
                .map((f) => [f.name, f.value as string])
            )
          : {},
      },
    });
  } catch (error) {
    console.error("Error fetching reservation:", error);
    captureBookingError(error instanceof Error ? error : new Error(String(error)), {
      step: "confirmation",
    });

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
