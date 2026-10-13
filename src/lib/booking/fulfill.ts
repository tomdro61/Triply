/**
 * Booking fulfilment — ResLab reservation, Supabase persistence, Park Guard
 * enrolment, and notification emails; and, for Triply direct lots (4b),
 * `persistDirectBooking` / `sendDirect*` / `buildDirectReservationResponse`,
 * which never touch ResLab.
 *
 * Extracted verbatim-in-behaviour from POST /api/reservations so the same
 * fulfilment can be driven by all three entry points (the browser, the
 * /checkout/complete redirect-return page, and the Stripe webhook). This module
 * knows NOTHING about payment state — no capture, no refund, no PaymentIntent
 * branching. That lives in create-booking.ts. Keeping them apart is deliberate:
 * money decisions must be readable in one place.
 */

import type { z } from "zod";
import { reslab, stripHtml } from "@/lib/reslab/client";
import type { ReslabReservation } from "@/lib/reslab/client";
import type {
  DirectFulfilledReservation,
  FulfilledReservation,
  ReslabFulfilledReservation,
} from "@/lib/booking/fulfilled-reservation";
import type { DirectBookingPayload } from "@/lib/direct/fulfilment";
import { snapshotAddressLine } from "@/lib/direct/lot-snapshot";
import { createAdminClient } from "@/lib/supabase/server";
import { linkableUserIdForEmail, sameEmail } from "@/lib/booking/customer-link";
import { sendBookingConfirmation } from "@/lib/resend/send-booking-confirmation";
import { sendAdminBookingNotification } from "@/lib/resend/send-admin-booking-notification";
import {
  buildCostBreakdown,
  fallbackDue,
  toCents,
  type CostBreakdownResult,
  type ProtectionInput,
} from "@/lib/booking/cost-breakdown";
import { directDays } from "@/lib/direct/pricing";
import { anchoredFallback, type AnchoredFallback } from "@/lib/resend/anchored-fallback";
import type { reservationSchema } from "@/lib/validation/schemas";
import {
  capturePaymentError,
  captureParkGuardError,
  captureBookingError,
} from "@/lib/sentry";
import { convertTo12Hour } from "@/lib/utils/time";
import { reslabExtraFieldValues } from "@/lib/booking/required-extra-fields";
// Attribution helpers are pure and import nothing from @/lib/reslab/search or
// @/lib/reslab/get-lot — the shared location-list cache is per-lambda and cold
// here, and a sweep after capture is the Aug-16 outage class. A static test
// (src/lib/attribution/__tests__/no-reslab-list-in-booking.test.ts) pins this.
import {
  normalizeStoredAttribution,
  type Attribution,
  type Channel,
} from "@/lib/attribution/schema";
import { classifyChannel, PARTNER_SOURCE_RE } from "@/lib/attribution/classify";
import { resolveAirportCode, validCoords } from "@/lib/attribution/airport";
import {
  parkGuard,
  type ProtectionPlanTier,
  ParkGuardError,
  PARKGUARD_STATUS,
  formatPgDate,
} from "@/lib/parkguard/client";

export type BookingPayload = z.infer<typeof reservationSchema>;

/**
 * The Park Guard tier the customer actually paid for, with the premium the
 * PaymentIntent was charged (NOT the live retail). Resolved by the booking
 * engine from PI metadata and threaded through the row snapshot, the PG
 * capture and the emails so all of them describe the same purchase.
 */
export interface ChargedProtection {
  plan: ProtectionPlanTier;
  /** Dollars, as charged. */
  premium: number;
}

export type PgSyncStatus = "pending" | "synced" | "skipped_missing_data" | null;

export interface PersistResult {
  bookingId: string | null;
  /** The airport written to the row (derived server-side, migration 023 era).
   *  Threaded to the admin email so it never reports the client's "RESLAB". */
  airportCode: string | null;
  pgIdentifier: string | null;
  pgSyncStatus: PgSyncStatus;
  /** True when the booking row itself failed to insert. Money is already
   *  committed at this point, so the caller must escalate rather than refund. */
  bookingInsertFailed: boolean;
  /** True when that failure will recur identically on every retry — a Postgres
   *  integrity violation (23xxx other than 23505). Retrying those burns Stripe's
   *  entire ~3-day redelivery budget on an insert that can never succeed, and
   *  leaves the pending row parked with nothing left to re-drive it. */
  bookingInsertPermanent: boolean;
  /** Set on ANY 23505 from the bookings insert. Usually a concurrent caller's
   *  insert of this PaymentIntent, but possibly another booking's reservation
   *  number; the caller looks the row up by PaymentIntent to tell which (4b §3.3 B7). */
  duplicatePaymentIntent: boolean;
  /** Promo discount actually taken off the online charge, in dollars (0 when
   *  none) — the value written to bookings.discount_amount. The emails need it:
   *  without it their "Total" overstated what a promo customer paid. */
  discountAmount: number;
}

/**
 * Create the reservation at ResLab.
 *
 * Throws on failure. The caller MUST distinguish a definitive rejection (4xx —
 * nothing was created, safe to release the payment) from an ambiguous one
 * (5xx / timeout — a reservation may or may not exist, and ResLab gives us no
 * idempotency key with which to find out). See classifyReslabError.
 */
export async function createReslabReservation(
  payload: BookingPayload
): Promise<ReslabReservation> {
  const { customer, vehicle, extraFields } = payload;

  // The same map the pending route validates before the charge — see
  // required-extra-fields.ts. Never build it inline here.
  const apiExtraFields = reslabExtraFieldValues(vehicle, extraFields);

  const fullName = `${customer.firstName} ${customer.lastName}`;

  return reslab.createReservation({
    location_id: payload.locationId,
    costs_token: payload.costsToken,
    reserved_by: fullName,
    reserved_for: fullName,
    phone: customer.phone,
    email: customer.email,
    items: [
      {
        type: "parking",
        reservation_type: "parking",
        type_id: payload.parkingTypeId,
        from_date: payload.fromDate,
        to_date: payload.toDate,
        number_of_spots: 1,
      },
    ],
    ...apiExtraFields,
  });
}

/**
 * Persist the customer + booking rows, then enrol Park Guard.
 *
 * Never throws — every failure is captured and reported through PersistResult so
 * the payment state machine can decide what to do with money that has already
 * moved. Throwing here would strand the caller mid-transition.
 */
/** The promo the customer redeemed, derived from PI metadata by the caller.
 *  `code` is the redeemed code (uppercased); `discountPercent` is the applied
 *  percent (0 when none); `chargedCents` is `pi.amount` — the REAL amount Stripe
 *  charged, used to derive the discount exactly. Absent on the DEV_SKIP_PAYMENT
 *  path (no PaymentIntent). */
export interface AppliedPromo {
  code: string | null;
  discountPercent: number;
  chargedCents: number;
}

/**
 * The promo discount actually taken off a ResLab booking's online charge, in
 * dollars (0 when none), and the code to record (only when a discount
 * applied). Pure — the ONE derivation shared by `persistBooking` (the stored
 * `discount_amount`) and the booking emails, which take it from here rather
 * than from persistence: a persistence failure must never zero the discount
 * in a permanent email (cost-breakdown plan v2 §3).
 *
 * Derived from the ACTUAL Stripe charge (`chargedCents`) rather than
 * re-computing percent × subtotal. Re-rounding the discount by itself drifted
 * 1¢ vs Stripe on ~19% of promos (half-cent-boundary subtotals like ".95" at
 * 10%): Stripe subtracts an UNROUNDED discount and rounds the whole total
 * once. Deriving from what was actually charged makes admin "Paid online"
 * (= booking total − due − discount) reconcile to Stripe EXACTLY.
 */
export function appliedPromoDiscount(
  payload: Pick<BookingPayload, "grandTotal" | "triplyServiceFee">,
  fr: ReslabFulfilledReservation,
  charged: ChargedProtection | null,
  promo?: AppliedPromo
): { discountAmount: number; promoCode: string | null } {
  const protectionPremium = charged?.premium ?? 0;
  const discountPercent = promo?.discountPercent ?? 0;
  let discountAmount = 0;
  if (discountPercent > 0 && promo) {
    const preDiscountOnlineCents = Math.round(
      ((fr.money.grandTotal ?? payload.grandTotal ?? 0) +
        (payload.triplyServiceFee || 0) +
        protectionPremium -
        (fr.money.dueAtLocation || 0)) *
        100
    );
    discountAmount =
      Math.max(0, preDiscountOnlineCents - promo.chargedCents) / 100;
  }
  // Only record the code when a discount was actually applied (an invalid code
  // that was typed but not honored leaves no discount and isn't "used").
  const promoCode = discountAmount > 0 ? promo?.code ?? null : null;
  return { discountAmount, promoCode };
}

export async function persistBooking(
  payload: BookingPayload,
  fr: ReslabFulfilledReservation,
  charged: ChargedProtection | null,
  /** Stripe mode of the charge (`pi.livemode`), written to bookings.livemode —
   *  the only staging/prod marker on this shared table (migration 034). Required,
   *  not optional: an omitted field is how every booking from Oct 5 to Oct 8,
   *  2026 got NULL. */
  livemode: boolean,
  promo?: AppliedPromo,
  /** Marketing attribution captured at stage time (migration 023). Optional:
   *  the dev-only fulfilOnly path has none. Threaded separately from `payload`
   *  because reservationSchema would strip it — see CreateBookingInput. */
  attribution?: Attribution | null
): Promise<PersistResult> {
  const {
    locationId,
    fromDate,
    toDate,
    customer,
    vehicle,
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
  } = payload;
  const protectionPlan = charged?.plan ?? null;
  const protectionPremium = charged?.premium ?? 0;

  const result: PersistResult = {
    bookingId: null,
    airportCode: null,
    pgIdentifier: null,
    pgSyncStatus: null,
    bookingInsertFailed: false,
    bookingInsertPermanent: false,
    duplicatePaymentIntent: false,
    discountAmount: 0,
  };

  try {
    const supabase = await createAdminClient();

    const customerId = await upsertCustomer(supabase, {
      userId,
      customer,
      stripePaymentIntentId,
    });

    const storedSubtotal = subtotal || fr.money.subtotal || 0;

    // Discount taken off the online charge by the promo, derived from the ACTUAL
    // Stripe charge — see appliedPromoDiscount (shared with the emails).
    const { discountAmount, promoCode } = appliedPromoDiscount(payload, fr, charged, promo);
    result.discountAmount = discountAmount;

    // The lot's IANA timezone for the self-cancel 24h gate. Primary source is
    // the ResLab reservation's embedded location; airport_code is NOT usable
    // (it is "RESLAB" on ~all bookings). Fall back to ONE getLocation call when
    // the reservation omits the timezone OR the lot coordinates (the airport
    // derivation below shares the fetch), in its OWN try/catch so a ResLab hiccup here can
    // never fail the money-committed insert (persistBooking's outer catch would
    // otherwise mark the whole booking failed). A remaining null fail-closes the
    // cancel gate for this booking (routes the customer to support) and is
    // Sentry-flagged so a feature-wide "nobody can cancel" regression is visible.
    let locationTimezone: string | null = fr.location?.timezone ?? null;
    // The lot's coordinates drive the airport derivation below. Same source,
    // same single fallback fetch — never the shared location-list cache.
    let lotCoords = fr.location?.coords ?? null;
    // ResLab only: persistBooking never sees a direct lot (see
    // persistDirectBooking); the source check restates that `locationId` is a
    // ResLab id.
    if (fr.source === "reslab" && (!locationTimezone || !lotCoords) && locationId != null) {
      try {
        const fetched = await reslab.getLocation(locationId);
        if (!locationTimezone) locationTimezone = fetched?.timezone?.code ?? null;
        if (!lotCoords) lotCoords = validCoords(fetched?.latitude, fetched?.longitude);
      } catch (locErr) {
        // Leave locationTimezone AS-IS: the reservation may already have
        // supplied it and this fetch may have run only for the coordinates. A
        // marketing-field fetch failing must never null a known timezone and
        // fail-close the customer's self-cancel gate.
        // Surface WHY the fallback failed (404 vs 5xx vs timeout vs auth) so a
        // systematic "nobody can self-cancel" regression is diagnosable rather
        // than an opaque null. Non-fatal — the null case is still handled below.
        captureBookingError(
          locErr instanceof Error ? locErr : new Error(String(locErr)),
          {
            step: "checkout",
            confirmationNumber: fr.number,
          }
        );
      }
    }
    if (!locationTimezone) {
      captureBookingError(
        new Error(
          `Booking persisted with null location_timezone (reslab_location_id=${locationId}); self-cancel gate will fail-closed for it`
        ),
        { step: "checkout", confirmationNumber: fr.number }
      );
    }

    const { storedAttribution, channel } = await deriveChannel(supabase, attribution, fr.number);

    // The client-supplied airportCode is "RESLAB" on ~all bookings (it is the
    // lot-id prefix) and is deliberately NOT written here. Derived instead from
    // the lot's coordinates, preferring the airport the visitor actually
    // searched when the lot is within range of it. Null when unresolvable.
    let derivedAirportCode: string | null = null;
    try {
      derivedAirportCode = resolveAirportCode({
        contextAirport:
          storedAttribution && storedAttribution.v === 1 ? (storedAttribution.apt ?? null) : null,
        lat: lotCoords?.lat,
        lng: lotCoords?.lng,
      });
    } catch (apErr) {
      derivedAirportCode = null;
      captureBookingError(
        apErr instanceof Error ? apErr : new Error(String(apErr)),
        { step: "checkout", confirmationNumber: fr.number }
      );
    }

    // --- Booking row ---------------------------------------------------------
    const { data: bookingRow, error: bookingError } = await supabase
      .from("bookings")
      .insert({
        customer_id: customerId,
        reslab_reservation_number: fr.number,
        reslab_location_id: locationId,
        location_name:
          locationName || fr.location?.name || `Location ${locationId}`,
        location_address: locationAddress || fr.location?.address || "",
        // Derived server-side (see above). NULL = unknown; never the client's
        // "RESLAB". airport_code is nullable (001) so this cannot 23502.
        airport_code: derivedAirportCode,
        // Migration 023. NULL attribution = cookie absent (pre-deploy, no JS).
        attribution: storedAttribution,
        channel,
        // IANA tz for the self-cancel 24h gate (resolved above). NULL fail-closes
        // the gate for this booking — never guessed.
        location_timezone: locationTimezone,
        // Literal wall-clock strings. bookings.check_in/check_out are TIMESTAMP
        // (migration 007), NOT TIMESTAMPTZ — no conversion, no Date math.
        check_in: fromDate,
        check_out: toDate,
        subtotal: storedSubtotal,
        tax_total: taxTotal || fr.money.taxTotal || 0,
        fees_total: feesTotal || fr.money.feesTotal || 0,
        // ResLab is source of truth for parking revenue; the client value is
        // only a fallback if ResLab didn't echo it back. The protection premium
        // lives in protection_plan_price so reporting can read them apart.
        grand_total: fr.money.grandTotal ?? grandTotal ?? 0,
        triply_service_fee: triplyServiceFee || 0,
        due_at_location: fr.money.dueAtLocation || 0,
        // Promo (migration 016). discount_amount is always written (0 = none) so
        // reporting never sees NULL; promo_code only when a discount applied.
        discount_amount: discountAmount,
        ...(promoCode && { promo_code: promoCode }),
        vehicle_info: vehicle,
        status: "confirmed",
        livemode,
        ...(stripePaymentIntentId && {
          stripe_payment_intent_id: stripePaymentIntentId,
        }),
        // Tier snapshot (migration 021): display name + code + the premium the
        // PaymentIntent was actually charged + the wholesale that applied at
        // fulfilment. Refunds and accounting read the row, so a later price or
        // contract change never rewrites history.
        ...(charged && {
          protection_plan: charged.plan.name,
          protection_plan_code: charged.plan.code,
          protection_plan_price: charged.premium,
          protection_plan_wholesale: charged.plan.wholesalePrice,
        }),
      })
      .select("id")
      .single();

    if (bookingError) {
      // 23505: usually a concurrent caller already inserted this booking (a
      // SUCCESS for idempotency — the customer has their reservation), but it
      // can also be the reservation-number UNIQUE. Flag it and let the caller
      // tell which by looking the row up by PaymentIntent; no money alert here.
      const code = (bookingError as { code?: string }).code;
      const isDuplicate = code === "23505";
      result.duplicatePaymentIntent = isDuplicate;
      result.bookingInsertFailed = !isDuplicate;
      // Postgres class 23 = integrity constraint violation (NOT NULL, FK, CHECK).
      // Deterministic: the same row will be rejected identically every time.
      result.bookingInsertPermanent =
        !isDuplicate && !!code && /^23\d{3}$/.test(code);

      if (!isDuplicate) {
        captureBookingError(
          new Error(`Booking insert failed: ${bookingError.message}`),
          { step: "checkout", airportCode }
        );
        if (protectionPlan) {
          const ctxErr = new Error(
            `Booking insert failed for protection-opted reservation; customer charged for premium but Park Guard not enrolled: ${bookingError.message}`
          );
          captureParkGuardError(ctxErr, {
            reslabReservationNumber: fr.number,
            operation: "capture",
          });
          if (stripePaymentIntentId) {
            capturePaymentError(ctxErr, {
              stripePaymentIntentId,
              amount: protectionPremium,
            });
          }
        }
      }
      return result;
    }

    result.bookingId = bookingRow.id;
    result.airportCode = derivedAirportCode;

    // --- Park Guard (non-blocking) ------------------------------------------
    if (charged && bookingRow?.id) {
      const pg = await enrolParkGuard(
        payload,
        fr,
        bookingRow.id,
        supabase,
        charged
      );
      result.pgIdentifier = pg.pgIdentifier;
      result.pgSyncStatus = pg.pgSyncStatus;
    }

    return result;
  } catch (supabaseError) {
    const sbErr =
      supabaseError instanceof Error
        ? supabaseError
        : new Error(String(supabaseError));
    result.bookingInsertFailed = true;
    captureBookingError(sbErr, { step: "checkout", airportCode });
    if (protectionPlan) {
      const ctxErr = new Error(
        `Supabase save failed for protection-opted reservation; customer charged for premium but Park Guard not enrolled: ${sbErr.message}`
      );
      captureParkGuardError(ctxErr, {
        reslabReservationNumber: fr.number,
        operation: "capture",
      });
      if (stripePaymentIntentId) {
        capturePaymentError(ctxErr, {
          stripePaymentIntentId,
          amount: protectionPremium,
        });
      }
    }
    return result;
  }
}

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

/**
 * Find or create the booker's `customers` row and return its id. Shared by the
 * ResLab and direct persists. Throws on a failed INSERT (the caller's catch
 * marks the booking insert failed); lookups and updates are reported and
 * tolerated, exactly as before this was extracted.
 */
async function upsertCustomer(
  supabase: AdminClient,
  args: {
    userId: string | null | undefined;
    customer: BookingPayload["customer"];
    stripePaymentIntentId: string | null | undefined;
  }
): Promise<string> {
  const { userId, customer, stripePaymentIntentId } = args;
  // --- Customer upsert -----------------------------------------------------
  // `userId` is the SERVER-SESSION user (the reservation routes overwrite
  // whatever the client sent) or, on the webhook/sweep paths, the id staged
  // on the pending row by those same routes. It selects the booker's own
  // customer row. It is NOT, on its own, permission to attach an
  // email-matched row to that account — see customer-link.ts: that was the
  // account-takeover hole (book under a victim's email, inherit their
  // booking history and self-cancel). Linking requires the account's
  // verified email to BE that address.
  let customerId: string;
  let existingCustomer: { id: string; email: string; user_id: string | null } | null = null;

  // Not `.single()`: PostgREST answers BOTH zero and multiple rows with the
  // same PGRST116, so a duplicated customer (customers has no UNIQUE on
  // email or user_id, and duplicates exist in prod) would read as "no
  // customer" and INSERT yet another row after the money moved. Read the
  // list, take the oldest row deterministically, and report duplicates and
  // faults — the booking continues either way.
  type CustomerRow = { id: string; email: string; user_id: string | null };
  const pickCustomer = (
    by: string,
    rows: CustomerRow[] | null,
    error: { message: string } | null
  ): CustomerRow | null => {
    if (error) {
      captureBookingError(
        new Error(`customers lookup by ${by} failed (pi=${stripePaymentIntentId ?? "none"}): ${error.message}`),
        { step: "checkout" }
      );
      return null;
    }
    if (!rows || rows.length === 0) return null;
    if (rows.length > 1) {
      captureBookingError(
        new Error(`${rows.length} customers rows share the same ${by} (pi=${stripePaymentIntentId ?? "none"}) — using the oldest; dedupe needed`),
        { step: "checkout" }
      );
    }
    return rows[0];
  };

  if (userId) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, email, user_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    existingCustomer = pickCustomer("user_id", data, error);
  }

  if (!existingCustomer) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, email, user_id")
      .eq("email", customer.email)
      .order("created_at", { ascending: true });
    existingCustomer = pickCustomer("email", data, error);
  }

  // The verified-email check is an external auth call inside the
  // post-capture critical section — only make it when it can change the
  // outcome (an unlinked matched row, or a brand-new row).
  const linkableUserId =
    existingCustomer && existingCustomer.user_id !== null
      ? null
      : await linkableUserIdForEmail(userId, customer.email);

  if (existingCustomer) {
    customerId = existingCustomer.id;
    // Link only a row that has NO account yet, and only to an account whose
    // verified email is this address. Never overwrite a different non-null
    // user_id — that is someone else's record.
    const linkHere =
      linkableUserId !== null && existingCustomer.user_id === null
        ? { user_id: linkableUserId }
        : {};
    // Refresh the contact details only when this booking is FOR that row's
    // address. A signed-in customer booking under someone else's email is
    // filed under their own row (found by user_id above) — the other
    // person's name and phone must not overwrite the account holder's.
    const contactHere = sameEmail(existingCustomer.email, customer.email)
      ? { first_name: customer.firstName, last_name: customer.lastName, phone: customer.phone }
      : {};
    const patch = { ...contactHere, ...linkHere };
    if (Object.keys(patch).length > 0) {
      const { error: updateError } = await supabase
        .from("customers")
        .update(patch)
        .eq("id", customerId);
      if (updateError) {
        // Non-fatal for the booking (the row exists and is correct enough to
        // attach to), but never silent.
        captureBookingError(
          new Error(`customers update failed (pi=${stripePaymentIntentId ?? "none"}): ${updateError.message}`),
          { step: "checkout" }
        );
      }
    }
  } else {
    const { data: newCustomer, error: customerError } = await supabase
      .from("customers")
      .insert({
        email: customer.email,
        first_name: customer.firstName,
        last_name: customer.lastName,
        phone: customer.phone,
        // A signed-in customer booking under a DIFFERENT email gets a plain
        // guest row for that address, not one attached to their account.
        ...(linkableUserId && { user_id: linkableUserId }),
      })
      .select("id")
      .single();

    if (customerError) throw customerError;
    customerId = newCustomer.id;
  }
  return customerId;
}

/**
 * Stored attribution + derived channel for a booking row. Never throws: a
 * throw here would fail a booking whose money is already captured. Shared by
 * the ResLab and direct persists.
 */
async function deriveChannel(
  supabase: AdminClient,
  attribution: Attribution | null | undefined,
  confirmationNumber: string
): Promise<{ storedAttribution: Attribution | null; channel: Channel | null }> {
  // --- Attribution channel (non-blocking) -----------------------------------
  // In its OWN try/catch: a throw inside the caller's try marks
  // bookingInsertFailed for a booking whose money is already captured. A null here is a reporting gap, not a
  // customer problem — captured to Sentry, never allowed to block the insert.
  // The pending row's JSONB is a boundary too: re-validate before trusting
  // its shape, so a corrupt row becomes the invalid marker, never a throw.
  // Inside the guard: safeParse cannot throw today, but a future refine on
  // the schema must not be able to fail a paid booking either.
  let storedAttribution: Attribution | null = null;
  let channel: Channel | null = null;
  try {
    storedAttribution = normalizeStoredAttribution(attribution);
    const validAttribution =
      storedAttribution && storedAttribution.v === 1 ? storedAttribution : null;
    if (validAttribution) {
      // `utm_source=partner-<reslab_location_id>` is visitor input; only an
      // ACTIVE partner row earns the partner channel, else it is a referral.
      // Lower-cased to match the classifier's own matching.
      let activePartnerLocationIds: Set<number> | undefined;
      const partnerTag = (validAttribution.first.src ?? "").toLowerCase().match(PARTNER_SOURCE_RE);
      if (partnerTag) {
        const { data: partner, error: partnerError } = await supabase
          .from("partners")
          .select("reslab_location_id")
          .eq("reslab_location_id", Number(partnerTag[1]))
          .eq("is_active", true)
          .maybeSingle();
        if (partnerError) {
          // A DB fault is not "no such partner". Asserting `referral` here
          // would permanently mislabel a partner booking with no trace, so
          // leave the channel unknown and say why.
          throw new Error(`partners lookup failed: ${partnerError.message}`);
        }
        activePartnerLocationIds = new Set(
          partner ? [Number((partner as { reslab_location_id: number }).reslab_location_id)] : []
        );
      }
      channel = classifyChannel(validAttribution, { activePartnerLocationIds });
    }
  } catch (chErr) {
    channel = null;
    captureBookingError(
      chErr instanceof Error ? chErr : new Error(String(chErr)),
      { step: "checkout", confirmationNumber }
    );
  }
  return { storedAttribution, channel };
}

/**
 * Park Guard enrolment. Never throws — a PG outage must not fail a paid booking,
 * but every failure is captured for background reconciliation.
 */
async function enrolParkGuard(
  payload: Pick<BookingPayload, "fromDate" | "toDate" | "customer" | "vehicle" | "locationAddress">,
  fr: FulfilledReservation,
  bookingId: string,
  supabase: AdminClient,
  charged: ChargedProtection
): Promise<{ pgIdentifier: string | null; pgSyncStatus: PgSyncStatus }> {
  const { fromDate, toDate, customer, vehicle, locationAddress } = payload;
  try {
    const [startDate, startTime24] = fromDate.split(" ");
    const [endDate, endTime24] = toDate.split(" ");
    // Local components, not toISOString — Vercel runs UTC, so toISOString would
    // shift late-evening ET bookings to the next day's date.
    const todayDate = formatPgDate(new Date());
    const pgLocation = fr.location;

    const pgStreet = pgLocation?.address || locationAddress;
    const pgCity = pgLocation?.city;
    const pgState = pgLocation?.stateCode;
    const pgZip = pgLocation?.zip;

    if (!pgStreet || !pgCity || !pgState || !pgZip) {
      // Distinct sentinel so alerting and reconciliation can tell this PERMANENT
      // skip apart from a transient outage. Empty strings would 422 on PG's side
      // and be indistinguishable from a real failure.
      captureParkGuardError(
        new Error(
          `Park Guard capture skipped — required address fields missing: street=${!!pgStreet}, city=${!!pgCity}, state=${!!pgState}, zip=${!!pgZip}`
        ),
        {
          bookingId,
          reslabReservationNumber: fr.number,
          operation: "capture",
          statusCode: PARKGUARD_STATUS.MISSING_DATA,
        }
      );
      const { error: skipUpdateErr } = await supabase
        .from("bookings")
        .update({ pg_sync_status: "skipped_missing_data" })
        .eq("id", bookingId);
      if (skipUpdateErr) {
        captureParkGuardError(
          new Error(
            `Failed to persist 'skipped_missing_data' status: ${skipUpdateErr.message}`
          ),
          {
            bookingId,
            reslabReservationNumber: fr.number,
            operation: "update",
          }
        );
      }
      return { pgIdentifier: null, pgSyncStatus: "skipped_missing_data" };
    }

    const pgRes = await parkGuard.captureReservation({
      reservation_id: bookingId,
      reservation_start_date: startDate,
      reservation_end_date: endDate,
      booking_date: todayDate,
      parking_street_address: pgStreet,
      parking_city: pgCity,
      parking_state: pgState,
      parking_zipcode: pgZip,
      // PG expects "Plan A"/"Plan B"/"Plan C" codes, not the display name.
      protection_plan: charged.plan.pgPlanCode,
      protection_plan_price: charged.premium,
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

    const { error: pgUpdateError } = await supabase
      .from("bookings")
      .update({ pg_identifier: pgRes.pg_identifier, pg_sync_status: "synced" })
      .eq("id", bookingId);

    if (pgUpdateError) {
      const isDuplicate = (pgUpdateError as { code?: string }).code === "23505";
      captureParkGuardError(
        new Error(
          `Park Guard captured but local pg_identifier update failed${
            isDuplicate
              ? " (duplicate — pg_identifier already on another row)"
              : ""
          }: ${pgUpdateError.message}`
        ),
        {
          bookingId,
          reslabReservationNumber: fr.number,
          operation: "update",
          pgIdentifier: pgRes.pg_identifier,
        }
      );
      // PG holds the enrolment but our row doesn't reflect it — leave sync
      // status null so the email and confirmation page both render "Confirming"
      // until ops repairs the row.
      return { pgIdentifier: pgRes.pg_identifier, pgSyncStatus: null };
    }

    return { pgIdentifier: pgRes.pg_identifier, pgSyncStatus: "synced" };
  } catch (pgError) {
    captureParkGuardError(
      pgError instanceof Error ? pgError : new Error(String(pgError)),
      {
        bookingId,
        reslabReservationNumber: fr.number,
        operation: "capture",
        ...(pgError instanceof ParkGuardError && {
          statusCode: pgError.statusCode,
        }),
      }
    );
    return { pgIdentifier: null, pgSyncStatus: null };
  }
}

/**
 * Confirmation + admin notification emails.
 *
 * Returns whether the CUSTOMER email sent. The caller persists that on the
 * pending row so a crash between the booking insert and the send doesn't lose
 * the confirmation permanently — booking-by-PI idempotency would otherwise skip
 * the send forever on any re-drive.
 *
 * Unlike the pre-rehaul code, failures go to Sentry rather than console.error:
 * a customer who paid and never got their confirmation is a support incident,
 * and it was previously invisible outside Vercel logs.
 */
/**
 * The money context the ResLab booking emails need from `createBooking` —
 * deliberately NOT from `persistBooking`'s result (cost-breakdown plan v2 §3):
 * a persistence failure must not zero the discount in a permanent email.
 */
export interface ReslabEmailMoney {
  /** What Stripe charged (`pi.amount`), in cents — the breakdown's anchor.
   *  null on the dev path (no PaymentIntent): the emails then fall back. */
  anchorChargedCents: number | null;
  /** Promo discount taken off the charge, in dollars (0 = none) — appliedPromoDiscount. */
  promoDiscount: number;
  /** The redeemed code; set only when promoDiscount > 0. */
  promoCode: string | null;
  /** The applied percent stamped on the PaymentIntent (`discountPercent`, 0 = none) —
   *  the independent check on promoDiscount (expectedPromoCents). */
  discountPercent: number;
}

/** The promo on a DIRECT booking's PaymentIntent: the redeemed code and the applied percent (0 = none). */
export interface DirectEmailPromo {
  code: string | null;
  percent: number;
}

/**
 * What the code's PERCENT gives on the base checkout applied it to, in cents —
 * worked out WITHOUT the charge, so a discount derived as "would-have-charged
 * − pi.amount" cannot absorb a moved price or a missing due-at-location
 * amount (core rule: within 1¢, else fallback). null when there is no percent
 * or no base → the breakdown falls back if a discount was taken.
 *
 *   ResLab  /api/checkout/lot: discount = reservation.sub_total × pct / 100
 *           (unrounded; Stripe rounds the whole charge) — ResLab's subtotal.
 *   Direct  readDirectMetadataMoney: min(grand, round(subtotal × pct / 100)).
 */
export function expectedPromoCents(
  percent: number,
  subtotal: number | null | undefined,
  capCents: number | null = null
): number | null {
  if (!(Number.isFinite(percent) && percent > 0 && percent <= 100)) return null;
  const base = toCents(subtotal);
  if (base === null) return null;
  const cents = Math.round((base * percent) / 100);
  return capCents === null ? cents : Math.min(capCents, cents);
}

/** "Plan A" — the plan as the customer chose it (never the tier's display name). */
function protectionInput(charged: ChargedProtection | null): ProtectionInput | null {
  return charged ? { name: `Plan ${charged.plan.code}`, premium: charged.premium } : null;
}

/**
 * The cost breakdown for a ResLab booking's emails. `fr.money` values are
 * passed as-is (never `?? 0`): a missing one makes it `{ ok: false }` and the
 * email shows the fallback layout. Days are null ("Parking"): ResLab bills
 * per lot (calendar days or 24-hour periods) and its reservation carries no
 * day count, so any count we derived could contradict the lot's own.
 */
export function reslabEmailBreakdown(
  payload: BookingPayload,
  fr: ReslabFulfilledReservation,
  charged: ChargedProtection | null,
  money: ReslabEmailMoney
): CostBreakdownResult {
  return safeBreakdown(fr.number, "reslab", () => buildCostBreakdown({
    source: "reslab",
    subtotal: fr.money.subtotal,
    fees: fr.money.feesTotal,
    longTermDiscount: fr.money.longTermDiscount,
    tax: fr.money.taxTotal,
    grandTotal: fr.money.grandTotal,
    dueAtLocation: fr.money.dueAtLocation,
    days: null,
    serviceFee: payload.triplyServiceFee,
    promoDiscount: money.promoDiscount,
    promoCode: money.promoDiscount > 0 ? money.promoCode : null,
    expectedPromoCents: expectedPromoCents(money.discountPercent, fr.money.subtotal),
    protection: protectionInput(charged),
    anchorChargedCents: money.anchorChargedCents,
    refundedCents: 0,
    cancelled: false,
  }));
}

/**
 * The emails run on the money path after capture; ResLab's body is cast, not
 * validated, so a value of an unexpected type (an object where a number was
 * promised) must not throw out of the send and cost the customer their
 * confirmation. Any throw is a fallback, never an exception — and is reported
 * WITH the error, so it can be diagnosed.
 */
export function safeBreakdown(
  confirmationNumber: string,
  inventorySource: "reslab" | "direct",
  build: () => CostBreakdownResult
): CostBreakdownResult {
  try {
    return build();
  } catch (err) {
    captureBookingError(err instanceof Error ? err : new Error(`cost breakdown threw: ${String(err)}`), {
      step: "confirmation",
      fingerprint: ["email-cost-breakdown-threw"],
      confirmationNumber,
      inventorySource,
    });
    return { ok: false, reason: "cost breakdown could not be built (unexpected input)" };
  }
}

/**
 * The cost breakdown for a DIRECT booking's emails. The anchor is the checked
 * charge (`chargedOnline` = chargeCents / 100, already verified against
 * `pi.amount` by readDirectMetadataMoney); the at-lot surcharge stays outside it.
 */
export function directEmailBreakdown(
  fr: DirectFulfilledReservation,
  charged: ChargedProtection | null,
  promo: DirectEmailPromo
): CostBreakdownResult {
  const stay = fr.dates[0];
  const range = stay ? directDays(stay.fromDate, stay.toDate) : null;
  return safeBreakdown(fr.number, "direct", () => buildCostBreakdown({
    source: "direct",
    subtotal: fr.money.subtotal,
    tax: fr.money.taxTotal,
    atLot: {
      surchargeCents: fr.atLot.surchargeCents,
      surchargeTaxCents: fr.atLot.surchargeTaxCents,
      vehicleSizeLabel: fr.atLot.vehicleSizeLabel,
    },
    days: range?.ok ? range.days : null,
    serviceFee: fr.money.serviceFee,
    promoDiscount: fr.money.discount,
    promoCode: fr.money.discount > 0 ? promo.code : null,
    expectedPromoCents: expectedPromoCents(promo.percent, fr.money.subtotal, toCents(fr.money.grandTotal)),
    protection: protectionInput(charged),
    anchorChargedCents: directAnchorCents(fr),
    refundedCents: 0,
    cancelled: false,
  }));
}

/** The charged plan for the anchored fallback — labelled `Plan ${code}`, like the breakdown. */
function chargedPlan(charged: ChargedProtection | null): { code: string; premium: number } | null {
  return charged ? { code: charged.plan.code, premium: charged.premium } : null;
}

/** Direct: the "due" is the at-lot surcharge estimate (surcharge + tax, in dollars; null = none) — shown unless unreadable. */
function directAnchoredFallback(
  breakdown: CostBreakdownResult,
  fr: DirectFulfilledReservation,
  charged: ChargedProtection | null
): AnchoredFallback | undefined {
  return anchoredFallback(
    breakdown,
    directAnchorCents(fr),
    (refusal) => fallbackDue({ source: "direct", recordedDue: directAtLotEstimate(fr), refusal, cancelled: false }),
    chargedPlan(charged)
  );
}

/** A direct booking's card charge in cents (= chargeCents = pi.amount, checked by readDirectMetadataMoney). */
function directAnchorCents(fr: DirectFulfilledReservation): number {
  return Math.round(fr.money.chargedOnline * 100);
}

/**
 * A breakdown that did not add up is reported — one Sentry issue per REASON
 * CLASS (fingerprint), the booking in the event's context — and the emails
 * show the anchored fallback. Not when the anchor is simply unknown (the dev
 * path, which has no PaymentIntent).
 */
function reportEmailBreakdownFallback(
  breakdown: CostBreakdownResult,
  confirmationNumber: string,
  inventorySource: "reslab" | "direct",
  airportCode: string | undefined
): void {
  if (breakdown.ok || breakdown.reason === "what the card was charged is unknown") return;
  captureBookingError(new Error(`Booking email cost breakdown fell back: ${breakdown.reason}`), {
    step: "confirmation",
    fingerprint: ["email-cost-breakdown-fallback", breakdown.reason],
    confirmationNumber,
    inventorySource,
    ...(airportCode && { airportCode }),
  });
}

export async function sendBookingEmails(
  payload: BookingPayload,
  fr: ReslabFulfilledReservation,
  pgSyncStatus: PgSyncStatus,
  charged: ChargedProtection | null,
  money: ReslabEmailMoney
): Promise<{ customerEmailSent: boolean }> {
  const {
    locationId,
    fromDate,
    toDate,
    customer,
    vehicle,
    locationName,
    locationAddress,
    grandTotal,
    triplyServiceFee,
    airportCode,
    stripePaymentIntentId,
  } = payload;

  const resLocation = fr.location;
  const shuttleDetails =
    stripHtml(resLocation?.shuttleDetailsHtml ?? null) || undefined;
  const specialConditions =
    stripHtml(resLocation?.specialConditionsHtml ?? null) || undefined;

  const protectionPremium = charged?.premium ?? 0;
  // The fallback layout's total (used only when the breakdown is not ok) —
  // net of the promo discount, so it is never a pre-discount amount labelled paid.
  const totalAmount =
    (fr.money.grandTotal ?? grandTotal ?? 0) +
    (triplyServiceFee || 0) +
    protectionPremium -
    money.promoDiscount;
  const breakdown = reslabEmailBreakdown(payload, fr, charged, money);
  reportEmailBreakdownFallback(breakdown, fr.number, "reslab", airportCode || undefined);
  // The recorded due amount AS RECEIVED (null stays null): the fallback never
  // states a missing or distrusted one as fact.
  const fallback = anchoredFallback(
    breakdown,
    money.anchorChargedCents,
    (refusal) =>
      fallbackDue({
        source: "reslab",
        recordedDue: fr.money.dueAtLocation,
        grandTotal: fr.money.grandTotal,
        parts: {
          subtotal: fr.money.subtotal,
          fees: fr.money.feesTotal,
          longTermDiscount: fr.money.longTermDiscount ?? 0,
          tax: fr.money.taxTotal,
        },
        refusal,
        cancelled: false,
      }),
    chargedPlan(charged)
  );

  const fullName = `${customer.firstName} ${customer.lastName}`;
  const vehicleInfo = `${vehicle.make} ${vehicle.model} (${vehicle.color}) - ${vehicle.licensePlate}`;

  let customerEmailSent = false;

  try {
    const [checkInDate, checkInTime24] = fromDate.split(" ");
    const [checkOutDate, checkOutTime24] = toDate.split(" ");
    const sent = await sendBookingConfirmation({
      to: customer.email,
      customerName: fullName,
      confirmationNumber: fr.number,
      lotName: locationName || resLocation?.name || `Location ${locationId}`,
      lotAddress: locationAddress || resLocation?.address || "",
      checkInDate,
      checkOutDate,
      checkInTime: convertTo12Hour(checkInTime24),
      checkOutTime: convertTo12Hour(checkOutTime24),
      totalAmount,
      dueAtLocation: fr.money.dueAtLocation || 0,
      vehicleInfo,
      shuttleDetails,
      specialConditions,
      ...(charged && {
        protectionPlan: charged.plan.name,
        protectionPlanPrice: charged.premium,
      }),
      pgSyncStatus,
      breakdown,
      ...(fallback && { anchoredFallback: fallback }),
    });
    // The sender never throws on a Resend error — it RETURNS { success: false }
    // (and reports it). Only a real acceptance counts as sent; marking a failed
    // send as sent hid customers who never got their confirmation.
    customerEmailSent = sent?.success === true;
    if (!customerEmailSent && stripePaymentIntentId) {
      capturePaymentError(
        new Error(`Customer paid but confirmation email did not send (reservation ${fr.number})`),
        { stripePaymentIntentId, amount: totalAmount }
      );
    }
  } catch (emailError) {
    captureBookingError(
      new Error(
        `Confirmation email failed for ${fr.number}: ${
          emailError instanceof Error ? emailError.message : String(emailError)
        }`
      ),
      { step: "checkout", airportCode }
    );
    if (stripePaymentIntentId) {
      capturePaymentError(
        new Error(
          `Customer paid but confirmation email did not send (reservation ${fr.number})`
        ),
        { stripePaymentIntentId, amount: totalAmount }
      );
    }
  }

  try {
    await sendAdminBookingNotification({
      confirmationNumber: fr.number,
      customerName: fullName,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      lotName: locationName || resLocation?.name || `Location ${locationId}`,
      lotAddress: locationAddress || resLocation?.address || "",
      checkInDate: fromDate.split(" ")[0],
      checkOutDate: toDate.split(" ")[0],
      totalAmount,
      dueAtLocation: fr.money.dueAtLocation || 0,
      vehicleInfo,
      airportCode: airportCode || undefined,
      ...(charged && {
        protectionPlan: charged.plan.name,
        protectionPlanPrice: charged.premium,
      }),
      breakdown,
      ...(fallback && { anchoredFallback: fallback }),
    });
  } catch (adminEmailError) {
    // Internal notification only — never escalated to a money event.
    captureBookingError(
      new Error(
        `Admin notification email failed for ${fr.number}: ${
          adminEmailError instanceof Error
            ? adminEmailError.message
            : String(adminEmailError)
        }`
      ),
      { step: "checkout", airportCode }
    );
  }

  return { customerEmailSent };
}

/**
 * The `reservation` object POST /api/reservations returns for a created
 * booking. Spelled out (not `ReturnType<…>`) so a change to the builder can't
 * silently change the API's type.
 */
export interface ReservationResponse {
  id: number | string;
  reservationNumber: string;
  status: string;
  grandTotal: number;
  serviceFee: number;
  protectionPlan: string | null;
  protectionPlanPrice: number;
  pgIdentifier: string | null;
  dueNow: number;
  dueAtLocation: number;
  customer: { firstName: string; lastName: string; email: string; phone: string };
  items: { type: string; fromDate: string | undefined; toDate: string | undefined; numberOfDays: null; numberOfSpots: number }[];
  /** Location fields are copied verbatim from the reservation — an absent one
   *  stays absent (dropped from the JSON), a null stays null. */
  location: {
    id: number | null | undefined;
    name: string | null | undefined;
    address: string | null | undefined;
    city: string | null | undefined;
    state: string | undefined;
    zipCode: string | null | undefined;
    phone: string | null | undefined;
    shuttleDetails: string | undefined;
    specialConditions: string | undefined;
  } | null;
}

/**
 * Shape the API response for a successfully created booking.
 */
export function buildReservationResponse(
  payload: BookingPayload,
  fr: ReslabFulfilledReservation,
  pgIdentifier: string | null,
  charged: ChargedProtection | null,
  /** Promo discount taken off the card charge, in dollars (0 = none) — appliedPromoDiscount.
   *  `dueNow` is what the card was charged, so it is net of it (cost-breakdown plan §4). */
  promoDiscount: number
): ReservationResponse {
  const resLocation = fr.location;
  const protectionPremium = charged?.premium ?? 0;
  const shuttleDetails =
    stripHtml(resLocation?.shuttleDetailsHtml ?? null) || undefined;
  const specialConditions =
    stripHtml(resLocation?.specialConditionsHtml ?? null) || undefined;

  return {
    id: fr.historyId || fr.number,
    reservationNumber: fr.number,
    status: fr.cancelled ? "cancelled" : "confirmed",
    grandTotal:
      (fr.money.grandTotal ?? payload.grandTotal ?? 0) +
      (payload.triplyServiceFee || 0) +
      protectionPremium,
    serviceFee: payload.triplyServiceFee || 0,
    protectionPlan: charged?.plan.name ?? null,
    protectionPlanPrice: protectionPremium,
    pgIdentifier,
    dueNow:
      (fr.money.grandTotal || 0) +
      (payload.triplyServiceFee || 0) +
      protectionPremium -
      (fr.money.dueAtLocation || 0) -
      promoDiscount,
    dueAtLocation: fr.money.dueAtLocation || 0,
    customer: {
      firstName: payload.customer.firstName,
      lastName: payload.customer.lastName,
      email: payload.customer.email,
      phone: payload.customer.phone,
    },
    items:
      fr.dates?.map((date) => ({
        type: "parking",
        fromDate: date.fromDate,
        toDate: date.toDate,
        numberOfDays: null,
        numberOfSpots: 1,
      })) || [],
    location: resLocation
      ? {
          id: resLocation.reslabLocationId,
          name: resLocation.name,
          address: resLocation.address,
          city: resLocation.city,
          state: resLocation.stateCode,
          zipCode: resLocation.zip,
          phone: resLocation.phone,
          shuttleDetails,
          specialConditions,
        }
      : null,
  };
}

// =============================================================================
// Direct lots (4b plan §3.3–§3.4) — persist, emails and the create response for
// a Triply-owned lot. No ResLab anywhere: everything comes from the staged row
// (DirectBookingPayload) and the PaymentIntent-derived DirectFulfilledReservation.
// =============================================================================

export type DirectPersistResult =
  | { kind: "inserted"; bookingId: string; pgIdentifier: string | null; pgSyncStatus: PgSyncStatus }
  /** 23505 on the bookings insert. The caller decides which UNIQUE fired (§3.3 B7). */
  | { kind: "unique_violation" }
  /** `permanent`: a Postgres integrity violation other than 23505 — identical on every retry. */
  | { kind: "failed"; permanent: boolean };

/**
 * Persist a DIRECT booking. Never throws (same contract as persistBooking).
 * Money comes from `fr.money` only — no payload fallback. `due_at_location` is
 * the stored 0 (the online charge covers all of the parking); an
 * oversized-vehicle surcharge is collected at the lot and lives only in the
 * `vehicle_*` columns, never in a money column. Timezone and airport come from
 * the snapshot — no ResLab lookup, no coordinate derivation.
 */
export async function persistDirectBooking(
  dp: DirectBookingPayload,
  fr: DirectFulfilledReservation,
  charged: ChargedProtection | null,
  livemode: boolean,
  promoCode: string | null,
  attribution: Attribution | null
): Promise<DirectPersistResult> {
  const s = fr.snapshot;
  const addressLine = snapshotAddressLine(s);
  try {
    const supabase = await createAdminClient();
    const customerId = await upsertCustomer(supabase, {
      userId: dp.userId,
      customer: dp.customer,
      stripePaymentIntentId: dp.stripePaymentIntentId,
    });
    const { storedAttribution, channel } = await deriveChannel(supabase, attribution, fr.number);

    const { data: bookingRow, error: bookingError } = await supabase
      .from("bookings")
      .insert({
        customer_id: customerId,
        reslab_reservation_number: fr.number,
        inventory_source: "direct",
        direct_lot_id: String(dp.directLotId),
        reslab_location_id: null,
        // Customer-safe v2 snapshot — no notice recipients (038 CHECK).
        lot_snapshot: s,
        location_name: s.name,
        location_address: addressLine,
        airport_code: s.airportCode,
        attribution: storedAttribution,
        channel,
        location_timezone: s.timezone,
        // Literal wall-clock strings into TIMESTAMP columns (007) — no conversion.
        check_in: dp.fromDate,
        check_out: dp.toDate,
        subtotal: fr.money.subtotal,
        tax_total: fr.money.taxTotal,
        fees_total: 0,
        grand_total: fr.money.grandTotal,
        triply_service_fee: fr.money.serviceFee,
        due_at_location: 0,
        discount_amount: fr.money.discount,
        ...(fr.money.discount > 0 && promoCode && { promo_code: promoCode }),
        vehicle_info: dp.vehicle,
        status: "confirmed",
        livemode,
        stripe_payment_intent_id: dp.stripePaymentIntentId,
        ...(charged && {
          protection_plan: charged.plan.name,
          protection_plan_code: charged.plan.code,
          protection_plan_price: charged.premium,
          protection_plan_wholesale: charged.plan.wholesalePrice,
        }),
        vehicle_size: dp.vehicleSize,
        vehicle_size_label: dp.vehicleSizeLabel,
        vehicle_surcharge_cents: dp.vehicleSurchargeCents,
        vehicle_surcharge_tax_cents: dp.vehicleSurchargeTaxCents,
        vehicle_size_source: dp.vehicleSizeSource,
      })
      .select("id")
      .single();

    if (bookingError) {
      const code = bookingError.code;
      if (code === "23505") return { kind: "unique_violation" };
      captureBookingError(new Error(`Direct booking insert failed: ${bookingError.message}`), {
        step: "checkout",
        airportCode: s.airportCode,
        confirmationNumber: fr.number,
      });
      return { kind: "failed", permanent: !!code && /^23\d{3}$/.test(code) };
    }

    if (!charged) return { kind: "inserted", bookingId: bookingRow.id, pgIdentifier: null, pgSyncStatus: null };
    const pg = await enrolParkGuard(
      { fromDate: dp.fromDate, toDate: dp.toDate, customer: dp.customer, vehicle: dp.vehicle, locationAddress: addressLine },
      fr,
      bookingRow.id,
      supabase,
      charged
    );
    return { kind: "inserted", bookingId: bookingRow.id, pgIdentifier: pg.pgIdentifier, pgSyncStatus: pg.pgSyncStatus };
  } catch (err) {
    captureBookingError(err instanceof Error ? err : new Error(String(err)), {
      step: "checkout",
      airportCode: s.airportCode,
      confirmationNumber: fr.number,
    });
    return { kind: "failed", permanent: false };
  }
}

/** What the customer paid online for a direct booking, in dollars (= pi.amount / 100). */
export function directPaidOnline(fr: DirectFulfilledReservation): number {
  return fr.money.chargedOnline;
}

/** The at-lot vehicle estimate (surcharge + its tax) in dollars; null when there is none. */
export function directAtLotEstimate(fr: DirectFulfilledReservation): number | null {
  const cents = fr.atLot.surchargeCents + fr.atLot.surchargeTaxCents;
  return cents > 0 ? cents / 100 : null;
}

const DIRECT_CONFIRMATION_TIMEOUT_MS = 5_000;

/**
 * The customer confirmation for a DIRECT booking. Returns whether Resend
 * ACCEPTED it (`{ success: true }`); never throws.
 *
 * Two callers, two ownership rules:
 *   - the checkout / re-drive path (no `adminResend`): the CALLER owns the
 *     claim-before-send on `pending_bookings.email_sent` (§10 F-1,
 *     create-booking's sendCustomerEmailOnce) and hands the claim back on
 *     `false`, so the sweep re-sends it;
 *   - the admin "Re-send customer confirmation" action (6b §6, `adminResend`):
 *     never touches that claim; it is audited in `direct_lot_resends` and
 *     sends under its own per-re-send key, so a deliberate re-send is not
 *     swallowed as a duplicate of the original.
 *
 * Bounded at 5 s: an unbounded send that hung to maxDuration would kill the
 * function after the claim, leaving `email_sent` true and the customer with no
 * confirmation and nothing to re-send it. The Resend idempotency key makes
 * handing the claim back safe even after a timeout (Resend may have delivered
 * it): the retry is then answered from Resend's record, not sent twice.
 */
export async function sendDirectCustomerConfirmation(
  dp: DirectBookingPayload,
  fr: DirectFulfilledReservation,
  pgSyncStatus: PgSyncStatus,
  charged: ChargedProtection | null,
  /** The promo on the PaymentIntent: code (trimmed + upper-cased; shown only when a discount applied) + percent. */
  promo: DirectEmailPromo,
  /** Set only by the admin re-send: its own Resend key, and its own failure report. Absent = the checkout path. */
  adminResend?: { idempotencyKey: string }
): Promise<boolean> {
  const idempotencyKey = adminResend?.idempotencyKey ?? `direct-confirmation/${dp.stripePaymentIntentId}`;
  const totalAmount = directPaidOnline(fr);
  const breakdown = directEmailBreakdown(fr, charged, promo);
  const fallback = directAnchoredFallback(breakdown, fr, charged);
  reportEmailBreakdownFallback(breakdown, fr.number, "direct", fr.snapshot.airportCode);
  const [checkInDate, checkInTime24] = dp.fromDate.split(" ");
  const [checkOutDate, checkOutTime24] = dp.toDate.split(" ");
  const v = dp.vehicle;
  try {
    const sent = await sendBookingConfirmation({
      to: dp.customer.email,
      customerName: `${dp.customer.firstName} ${dp.customer.lastName}`,
      confirmationNumber: fr.number,
      lotName: fr.snapshot.name,
      lotAddress: snapshotAddressLine(fr.snapshot),
      checkInDate,
      checkOutDate,
      checkInTime: convertTo12Hour(checkInTime24),
      checkOutTime: convertTo12Hour(checkOutTime24),
      totalAmount,
      dueAtLocation: 0,
      vehicleInfo: `${v.make} ${v.model} (${v.color}) - ${v.licensePlate}`,
      shuttleDetails: stripHtml(fr.location.shuttleDetailsHtml ?? null) || undefined,
      specialConditions: stripHtml(fr.location.specialConditionsHtml ?? null) || undefined,
      ...(charged && { protectionPlan: charged.plan.name, protectionPlanPrice: charged.premium }),
      pgSyncStatus,
      direct: {
        shuttlePhone: fr.snapshot.shuttlePhone ?? undefined,
        vehicleSizeLabel: fr.atLot.vehicleSizeLabel,
        atLotEstimate: directAtLotEstimate(fr),
        discount: fr.money.discount,
      },
      breakdown,
      ...(fallback && { anchoredFallback: fallback }),
      idempotencyKey,
      timeoutMs: DIRECT_CONFIRMATION_TIMEOUT_MS,
    });
    if (sent.success) return true;
    capturePaymentError(
      new Error(
        adminResend
          ? `Admin re-send of the confirmation failed or timed out (direct booking ${fr.number}) — ${sent.uncertain ? "Resend did not answer in time and may still deliver it" : "Resend did not accept it"}`
          : `Customer paid but confirmation email ${sent.uncertain ? "did not answer in time (Resend may still deliver it)" : "did not send"} (direct booking ${fr.number}) — handed back for a re-send`
      ),
      { stripePaymentIntentId: dp.stripePaymentIntentId, amount: totalAmount }
    );
    return false;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    capturePaymentError(
      new Error(
        adminResend
          ? `Admin re-send of the confirmation failed or timed out (direct booking ${fr.number}): ${detail}`
          : `Customer paid but confirmation email did not send (direct booking ${fr.number}): ${detail}`
      ),
      { stripePaymentIntentId: dp.stripePaymentIntentId, amount: totalAmount }
    );
    return false;
  }
}

/** Internal admin notification for a DIRECT booking. Never throws, never a money event. */
export async function sendDirectAdminNotification(
  dp: DirectBookingPayload,
  fr: DirectFulfilledReservation,
  charged: ChargedProtection | null,
  /** As for sendDirectCustomerConfirmation. */
  promo: DirectEmailPromo
): Promise<void> {
  const v = dp.vehicle;
  const atLot = directAtLotEstimate(fr);
  // Not reported again here: the customer email reports the same breakdown.
  const breakdown = directEmailBreakdown(fr, charged, promo);
  const fallback = directAnchoredFallback(breakdown, fr, charged);
  try {
    await sendAdminBookingNotification({
      confirmationNumber: fr.number,
      customerName: `${dp.customer.firstName} ${dp.customer.lastName}`,
      customerEmail: dp.customer.email,
      customerPhone: dp.customer.phone,
      lotName: fr.snapshot.name,
      lotAddress: snapshotAddressLine(fr.snapshot),
      checkInDate: dp.fromDate.split(" ")[0],
      checkOutDate: dp.toDate.split(" ")[0],
      totalAmount: directPaidOnline(fr),
      dueAtLocation: 0,
      vehicleInfo: `${v.make} ${v.model} (${v.color}) - ${v.licensePlate}`,
      airportCode: fr.snapshot.airportCode,
      ...(charged && { protectionPlan: charged.plan.name, protectionPlanPrice: charged.premium }),
      sourceLine: "Direct lot (Triply number — no Reservations Lab reservation)",
      vehicleDeclaration: `${fr.atLot.vehicleSizeLabel}${atLot !== null ? ` — $${atLot.toFixed(2)} est. collected at the lot` : ""}`,
      breakdown,
      ...(fallback && { anchoredFallback: fallback }),
    });
  } catch (err) {
    captureBookingError(
      new Error(`Admin notification email failed for ${fr.number}: ${err instanceof Error ? err.message : String(err)}`),
      { step: "checkout", airportCode: fr.snapshot.airportCode }
    );
  }
}

/** The `reservation` object POST /api/reservations returns for a created DIRECT booking. */
export function buildDirectReservationResponse(
  dp: DirectBookingPayload,
  fr: DirectFulfilledReservation,
  pgIdentifier: string | null,
  charged: ChargedProtection | null
): ReservationResponse {
  const protectionPremium = charged?.premium ?? 0;
  return {
    id: fr.number,
    reservationNumber: fr.number,
    status: "confirmed",
    grandTotal: fr.money.grandTotal + fr.money.serviceFee + protectionPremium,
    serviceFee: fr.money.serviceFee,
    protectionPlan: charged?.plan.name ?? null,
    protectionPlanPrice: protectionPremium,
    pgIdentifier,
    // The card charge. The at-lot vehicle estimate is NEVER part of this (R1).
    dueNow: directPaidOnline(fr),
    dueAtLocation: 0,
    customer: { ...dp.customer },
    items: fr.dates.map((d) => ({ type: "parking", fromDate: d.fromDate, toDate: d.toDate, numberOfDays: null, numberOfSpots: 1 })),
    location: {
      id: null,
      name: fr.location.name,
      address: fr.location.address,
      city: fr.location.city,
      state: fr.location.stateCode,
      zipCode: fr.location.zip,
      phone: fr.location.phone,
      shuttleDetails: stripHtml(fr.location.shuttleDetailsHtml ?? null) || undefined,
      specialConditions: stripHtml(fr.location.specialConditionsHtml ?? null) || undefined,
    },
  };
}
