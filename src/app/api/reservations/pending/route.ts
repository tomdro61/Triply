/**
 * POST /api/reservations/pending
 *
 * Stages the complete booking payload to `pending_bookings` immediately BEFORE
 * the customer confirms payment. This is what makes the booking survive the
 * browser: after this call, the Stripe webhook can create the reservation
 * server-side even if the customer is redirected to their bank and never
 * returns, closes the tab, or loses connectivity.
 *
 * SECURITY: this endpoint is unauthenticated (the customer is a guest at this
 * point), so it MUST bind the payload to the PaymentIntent. Without that, anyone
 * could stage a row for someone else's PaymentIntent and redirect the
 * confirmation email — and the fulfilment paths trust this row for the ResLab
 * reservation (vehicle, name, phone are not in PI metadata). Every field the
 * PaymentIntent can corroborate is checked; `protectionPlanCode` is DERIVED from
 * PI metadata rather than trusted, because it determines what the customer paid.
 *
 * DIRECT lots (`stageDirect`): also upserts the service-role-only
 * `direct_booking_terms` row (written first), and the staged row is the SOLE
 * fulfilment source — the engine ignores any client payload (§9 H-A).
 *
 * Both branches answer an already-AUTHORIZED PaymentIntent with 409
 * `already_authorized` before any other check (the client hands off to
 * /checkout/complete; never "you have not been charged").
 */

import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import { createAdminClient } from "@/lib/supabase/server";
import { pendingBookingSchema, directPendingBookingSchema } from "@/lib/validation/schemas";
import { z } from "zod";
import { DIRECT_ENGINE_READY, isDirectCheckoutOpen } from "@/lib/direct/flag";
import { directVehicleEstimate } from "@/lib/direct/vehicle-estimate";
import { readDirectMetadataMoney } from "@/lib/direct/metadata-money";
import { quoteDirectCheckout } from "@/lib/direct/checkout-quote";
import { parseDirectLotUnifiedId } from "@/lib/direct/store";
import { buildLotSnapshotV2 } from "@/lib/direct/lot-snapshot-build";
import { snapshotAddressLine } from "@/lib/direct/lot-snapshot";
import { NO_OVERSIZED_VEHICLE } from "@/lib/direct/vehicle-size";
import { NO_OVERSIZED_LABEL } from "@/lib/direct/vehicle-display";
import { convertTo24Hour } from "@/lib/utils/time";
import {
  capturePaymentError,
  captureBookingError,
  captureRequiredFieldCheck,
} from "@/lib/sentry";
import { readProtectionMetadata, STALE_CHECKOUT_MESSAGE } from "@/lib/parkguard/client";
import { readAttributionFromRequest } from "@/lib/attribution/read-request";
import { sessionIdentityFromRequest } from "@/lib/booking/customer-link";
import { reslab, ReslabError } from "@/lib/reslab/client";
import {
  declaredExtraFieldsSchema,
  missingRequiredExtraFields,
  invalidFormatExtraFields,
  isFlightNumberField,
  isUnnormalizedFlightNumber,
  FLIGHT_NUMBER_EXAMPLE,
  reslabExtraFieldValues,
  REQUIRED_FIELD_LOOKUP_TIMEOUT_MS,
  type DeclaredExtraField,
} from "@/lib/booking/required-extra-fields";

// Direct staging's bounded waits add up to ~33 s in the worst case (PaymentIntent
// 4 s + lot read 4 s + session 4 s + seven DB calls at 3 s), so the function
// limit sits above that: a slow database then fails CLOSED with our own 503,
// never a platform 504 with nothing in Sentry (4b plan §10 F-13, pass-1 review).
export const maxDuration = 40;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    // A checkout page loaded before the plan-tier deploy still posts the old
    // boolean. Refuse with an actionable message instead of a Zod issue.
    if (body && typeof body === "object" && "hasProtectionPlan" in body) {
      return NextResponse.json({ error: STALE_CHECKOUT_MESSAGE }, { status: 400 });
    }
    // A direct lot is chosen ONLY by an explicit inventorySource; every other
    // body takes the ResLab path exactly as before.
    if (body && typeof body === "object" && (body as Record<string, unknown>).inventorySource === "direct") {
      return await stageDirect(body, request);
    }
    const result = pendingBookingSchema.safeParse(body);
    if (!result.success) {
      // This endpoint runs BEFORE confirmPayment — the customer genuinely has
      // not been charged on any failure here. Say so, on every message: the
      // client shows these verbatim, and the reassurance is the whole point of
      // failing closed before the charge.
      return NextResponse.json(
        { error: `${result.error.issues[0].message} — you have not been charged.` },
        { status: 400 }
      );
    }

    const payload = result.data;
    const piId = payload.stripePaymentIntentId;

    const pi = await stripe.paymentIntents.retrieve(piId);
    const meta = pi.metadata ?? {};

    // --- PaymentIntent state FIRST (4b plan §9 M-A, §10 F-9) -----------------
    // Already authorized = Pay pressed again after the first finish failed: the
    // booking is under way. Never a "not charged" refusal, and never staged
    // again (the client would call confirmPayment on an authorized payment and
    // show Stripe's raw error) — hand off to /checkout/complete.
    if (AUTHORIZED_PI_STATUSES.has(pi.status)) return alreadyAuthorized(piId);
    if (pi.status === "canceled") {
      return NextResponse.json(
        { error: "This payment has expired. Please go back and start checkout again — you have not been charged.", code: "payment_not_stageable" },
        { status: 400 }
      );
    }

    // --- Bind the payload to the PaymentIntent -------------------------------
    // Keys added by this release are checked only WHEN PRESENT: PaymentIntents
    // created before deploy won't carry them, and rejecting those would break
    // every checkout already in flight at cutover.
    const mismatches: string[] = [];

    // Cross-source (A-29): a direct-lot PaymentIntent carries none of the
    // ResLab keys checked below, so without this a ResLab-shaped body would
    // bind to it unchallenged.
    if (meta.inventorySource && meta.inventorySource !== "reslab") {
      mismatches.push("inventorySource");
    }

    if (
      meta.customerEmail &&
      meta.customerEmail.trim().toLowerCase() !==
        payload.customer.email.trim().toLowerCase()
    ) {
      mismatches.push("customerEmail");
    }
    if (meta.locationId && Number(meta.locationId) !== payload.locationId) {
      mismatches.push("locationId");
    }
    if (meta.checkin && !payload.fromDate.startsWith(meta.checkin)) {
      mismatches.push("checkin");
    }
    if (meta.checkout && !payload.toDate.startsWith(meta.checkout)) {
      mismatches.push("checkout");
    }
    if (
      meta.parkingTypeId &&
      Number(meta.parkingTypeId) !== payload.parkingTypeId
    ) {
      mismatches.push("parkingTypeId");
    }

    if (mismatches.length > 0) {
      capturePaymentError(
        new Error(
          `Pending-booking staging rejected — payload does not match PaymentIntent metadata: ${mismatches.join(
            ", "
          )}`
        ),
        { stripePaymentIntentId: piId, amount: pi.amount / 100 }
      );
      return NextResponse.json(
        { error: "Booking details do not match this payment — you have not been charged." },
        { status: 400 }
      );
    }

    // Authoritative, not client-supplied: this determines what Stripe charged.
    // The tier code and its price are stamped as a PAIR by /api/checkout/lot
    // and /update-pi (see readProtectionMetadata). Both present → that tier;
    // both absent → no protection. A half pair, an unknown code, or a
    // price-only pair (which only the pre-tier bundle could stamp) is refused:
    // we are still before the charge, and guessing either way would stage a
    // tier other than the one Stripe holds.
    const metaProtection = readProtectionMetadata(meta);
    if (metaProtection.kind === "invalid" || metaProtection.kind === "legacy_plan_a") {
      capturePaymentError(
        new Error(
          `Pending-booking staging rejected — PaymentIntent protection metadata ${
            metaProtection.kind === "invalid"
              ? `is inconsistent: ${metaProtection.detail}`
              : "carries a price but no tier code (pre-tier bundle)"
          }`
        ),
        { stripePaymentIntentId: piId, amount: pi.amount / 100 }
      );
      return NextResponse.json(
        {
          error:
            "Your protection selection couldn't be verified — please choose it again. You have not been charged.",
        },
        { status: 400 }
      );
    }
    const protectionPlanCode =
      metaProtection.kind === "tier" ? metaProtection.code : null;

    // The client's own value must agree with what Stripe holds. It can only
    // differ through a bug or a tampered request: the selector is locked while
    // an /update-pi call is in flight and Pay Now stays disabled until it lands.
    if (payload.protectionPlanCode !== protectionPlanCode) {
      capturePaymentError(
        new Error(
          `Pending-booking staging rejected — client protectionPlanCode ${JSON.stringify(
            payload.protectionPlanCode
          )} does not match PaymentIntent metadata ${JSON.stringify(protectionPlanCode)}`
        ),
        { stripePaymentIntentId: piId, amount: pi.amount / 100 }
      );
      return NextResponse.json(
        {
          error:
            "Your protection selection doesn't match this payment — please choose it again. You have not been charged.",
        },
        { status: 400 }
      );
    }

    // Marketing attribution from the first-party cookie — read AFTER the body
    // and PaymentIntent checks above, never from the client body. Absent/
    // invalid resolve to null / an "invalid" marker; it never blocks staging.
    const attribution = readAttributionFromRequest(request, { stripePaymentIntentId: piId });

    // Identity from the session cookie, never the client body (see
    // customer-link.ts). Staged on the row so the webhook and sweep paths —
    // which have no session — fulfil with the same server-derived id.
    const { identity, reason: identityReason } = await sessionIdentityFromRequest();
    if (payload.userId && payload.userId !== (identity?.userId ?? null)) {
      // Two very different situations, kept apart at triage: the server could
      // not read a session at all (an auth fault or a token race — the
      // customer becomes a guest for this booking), or it read a DIFFERENT
      // user than the body claims (tampering, or a sign-out in another tab).
      captureBookingError(
        new Error(
          identityReason === "auth_error"
            ? `session unreadable; client userId dropped (booking proceeds as guest) pi=${piId}`
            : identity === null
              ? `client sent a userId but no session cookie was present (stale bundle or signed out) pi=${piId}`
              : `client-supplied userId differs from the session user pi=${piId}`
        ),
        { step: "checkout" }
      );
    }
    const sessionUserId = identity?.userId ?? null;

    // --- Refuse to overwrite work already in progress ------------------------
    const supabase = await createAdminClient();

    const { data: existingBooking, error: existingBookingError } = await supabase
      .from("bookings")
      .select("id")
      .eq("stripe_payment_intent_id", piId)
      .maybeSingle();
    if (existingBookingError) {
      // Can't tell whether this payment is already booked: refuse rather than
      // stage over it (4b plan §9 M-A). The card is not confirmed yet.
      capturePaymentError(
        new Error(`Pending-booking staging: existing-booking read failed: ${existingBookingError.message}`),
        { stripePaymentIntentId: piId, amount: pi.amount / 100 }
      );
      return NextResponse.json(
        { error: "Could not prepare your booking. Please try again — you have not been charged." },
        { status: 503 }
      );
    }

    if (existingBooking) {
      // Already fulfilled. Staging now would be a no-op at best and could
      // repoint a confirmation at worst.
      return NextResponse.json({ staged: false, reason: "already_booked" });
    }

    // --- Required lot fields, BEFORE the charge -----------------------------
    // ResLab rejects a reservation whose lot-declared field is blank, and it
    // does so after the card is authorised (the auth is released; the sale is
    // lost). The checkout step gates this too, but the client is never the
    // only gate on a money path. Checked against the exact map fulfilment
    // sends (reslabExtraFieldValues). Placed before the insert so a staged row
    // — which later retries never overwrite — can't carry a blank field.
    const lookup = await declaredExtraFieldsFor(payload.locationId, piId);
    if (lookup.kind === "lot_not_found") {
      // Definitive, not transient: ResLab would refuse the reservation after
      // the card is authorised. Stop here, before the charge.
      return NextResponse.json(
        {
          error:
            "This lot is no longer available to book. Please choose another lot — you have not been charged.",
        },
        { status: 400 }
      );
    }
    if (lookup.kind === "declared") {
      const sentValues = reslabExtraFieldValues(payload.vehicle, payload.extraFields);
      const missing = missingRequiredExtraFields(lookup.fields, sentValues);
      if (missing.length > 0) {
        const labels = missing.map((f) => f.label?.trim() || f.name).join(", ");
        // The vehicle step gates the same fields, so reaching this means the
        // two gates disagree or the lot changed its fields after the page
        // loaded. Either is worth knowing about. Names only, never answers.
        captureRequiredFieldCheck(
          "refused",
          "Pending-booking staging refused: required lot field(s) blank at the server gate",
          {
            stripePaymentIntentId: piId,
            locationId: payload.locationId,
            detail: { missingFields: missing.map((f) => f.name) },
          }
        );
        return NextResponse.json(
          {
            // Never offer N/A for a flight field: ResLab refuses it.
            error: `This lot needs: ${labels}. Please go back to Vehicle Information and fill it in${
              missing.some(isFlightNumberField) ? "" : " (enter N/A if it doesn't apply)"
            }. If you don't see it there, reload the page — you have not been charged.`,
            missingFields: missing.map((f) => f.name),
          },
          { status: 400 }
        );
      }

      // ResLab format-checks flight fields and answers 422 "Invalid Flight
      // Number" — after the card is authorised. Refuse here instead.
      const invalid = invalidFormatExtraFields(lookup.fields, sentValues);
      if (invalid.length > 0) {
        captureRequiredFieldCheck(
          "refused",
          "Pending-booking staging refused: flight field would be rejected by ResLab",
          {
            stripePaymentIntentId: piId,
            locationId: payload.locationId,
            detail: { invalidFields: invalid.map((f) => f.name) },
          }
        );
        const invalidLabels = invalid.map((f) => f.label?.trim() || f.name).join(", ");
        // A real flight number that only lacks the sent form comes from a page
        // loaded before this release: there is nothing for the customer to
        // correct, only to reload.
        const onlyFormatting = invalid.every((f) => isUnnormalizedFlightNumber(sentValues[f.name]));
        return NextResponse.json(
          {
            error: onlyFormatting
              ? "This page is out of date. Please reload it and try again — you have not been charged."
              : `Enter a flight number (for example ${FLIGHT_NUMBER_EXAMPLE}) for: ${invalidLabels}. Please go back to Vehicle Information to correct this — you have not been charged.`,
            invalidFields: invalid.map((f) => f.name),
          },
          { status: 400 }
        );
      }
    }

    // Insert only. An existing row means either a retry of this same staging
    // call or a fulfilment already under way — either way the stored payload
    // wins, so we never clobber a row another caller may be mid-way through.
    const { error: insertError } = await supabase
      .from("pending_bookings")
      .insert({
        stripe_payment_intent_id: piId,
        location_id: payload.locationId,
        costs_token: payload.costsToken,
        from_date: payload.fromDate,
        to_date: payload.toDate,
        parking_type_id: payload.parkingTypeId,
        customer: payload.customer,
        vehicle: payload.vehicle,
        extra_fields: payload.extraFields ?? null,
        confirmation_params: payload.confirmationParams ?? null,
        location_name: payload.locationName ?? null,
        location_address: payload.locationAddress ?? null,
        airport_code: payload.airportCode ?? null,
        subtotal: payload.subtotal ?? null,
        tax_total: payload.taxTotal ?? null,
        fees_total: payload.feesTotal ?? null,
        grand_total: payload.grandTotal ?? null,
        triply_service_fee: payload.triplyServiceFee ?? null,
        user_id: sessionUserId,
        // Written in lockstep: the boolean predates the tier column and is
        // still read by the legacy-row rule in create-booking.ts.
        has_protection_plan: protectionPlanCode !== null,
        protection_plan_code: protectionPlanCode,
        attribution,
        livemode: pi.livemode,
        status: "pending",
      });

    if (insertError) {
      // 23505 = the row already exists: an EARLIER Pay Now attempt on this
      // PaymentIntent (e.g. a declined card). The stored payload stands —
      // except the tier, which the customer may have changed in between; the
      // tier derived above is what Stripe holds NOW. Refresh only those two
      // columns, only while the row is still `pending` (never clobber a row a
      // fulfilment path has claimed). Fulfilment re-derives the tier from the
      // PaymentIntent regardless; this keeps the durable row honest for ops
      // and reconciliation, and keeps the fulfilment-side mismatch alert quiet
      // on this legitimate flow.
      if ((insertError as { code?: string }).code === "23505") {
        const { error: refreshError } = await supabase
          .from("pending_bookings")
          .update({
            protection_plan_code: protectionPlanCode,
            has_protection_plan: protectionPlanCode !== null,
          })
          .eq("stripe_payment_intent_id", piId)
          // `failed` too: a declined card marks the row failed, and the retry
          // on the same PaymentIntent may carry a different tier (the engine
          // reopens that row once the retry is authorized).
          .in("status", ["pending", "failed"])
          .is("reslab_reservation_number", null);
        if (refreshError) {
          // Not fatal: fulfilment trusts the PaymentIntent, not this column.
          capturePaymentError(
            new Error(
              `Pending-booking tier refresh failed on already_staged row: ${refreshError.message}`
            ),
            { stripePaymentIntentId: piId, amount: pi.amount / 100 }
          );
        }
        return NextResponse.json({ staged: true, reason: "already_staged" });
      }
      throw new Error(insertError.message);
    }

    return NextResponse.json({ staged: true });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    capturePaymentError(err, {});
    // FAIL CLOSED. The client aborts the charge when this call fails, which is
    // the intended trade: a customer who cannot check out is recoverable, a
    // customer charged with no durable record of what they bought is not.
    return NextResponse.json(
      { error: "Could not prepare your booking. Please try again — you have not been charged." },
      { status: 500 }
    );
  }
}

type DeclaredFieldLookup =
  | { kind: "declared"; fields: DeclaredExtraField[] }
  | { kind: "lot_not_found" }
  | { kind: "skipped" };

const LOOKUP_TIMED_OUT = Symbol("required-field-lookup-timeout");

/** How reslab/client.ts words a failed API call, as opposed to a failed login. */
const RESLAB_REQUEST_FAILED_PREFIX = "API request failed";

/**
 * The lot's declared extra fields, read fresh from ResLab (the checkout page's
 * copy is client-supplied and cannot be trusted as the gate).
 *
 * "skipped" FAILS OPEN on purpose, for a transient fault only (timeout, 5xx,
 * 429, an unreadable shape): this check is new, the client-side step gate
 * still runs, and blocking every checkout during a ResLab blip would lose more
 * sales than it saves. It is never silent: every skip is captured with its
 * reason. A 404 is not a blip — the lot is gone — and is refused.
 */
async function declaredExtraFieldsFor(
  locationId: number,
  piId: string
): Promise<DeclaredFieldLookup> {
  const context = { stripePaymentIntentId: piId, locationId };
  let raw: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // When the deadline wins, the ResLab call is still in flight and settles
    // later; Promise.race has already attached handlers to it, so a late
    // rejection is handled and its outcome simply no longer matters.
    const lookup = reslab.getLocation(locationId);
    const deadline = new Promise<typeof LOOKUP_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(LOOKUP_TIMED_OUT), REQUIRED_FIELD_LOOKUP_TIMEOUT_MS);
    });
    const result = await Promise.race([lookup, deadline]);
    if (result === LOOKUP_TIMED_OUT) {
      captureRequiredFieldCheck(
        "skipped",
        "Pending-booking required-field check skipped: ResLab lookup timed out",
        { ...context, detail: { reason: "timeout", timeoutMs: REQUIRED_FIELD_LOOKUP_TIMEOUT_MS } }
      );
      return { kind: "skipped" };
    }
    if (!("extra_fields" in result)) {
      // An explicit null or [] is a lot that declares nothing. NO key at all is
      // a response we do not recognise: the gate must not switch itself off
      // without a trace.
      captureRequiredFieldCheck(
        "skipped",
        "Pending-booking required-field check skipped: unexpected extra_fields shape",
        { ...context, detail: { issue: "extra_fields key absent from the location" } }
      );
      return { kind: "skipped" };
    }
    raw = result.extra_fields ?? [];
  } catch (error) {
    // Only a 404 for the LOCATION is definitive. The login call throws the
    // same error class ("Authentication failed: …"); a 404 there is a fault on
    // the way to ResLab, not a missing lot, and fails open like any other.
    if (
      error instanceof ReslabError &&
      error.statusCode === 404 &&
      error.message.startsWith(RESLAB_REQUEST_FAILED_PREFIX)
    ) {
      captureRequiredFieldCheck(
        "lot_not_found",
        "Pending-booking staging refused: ResLab reports the lot does not exist (404)",
        { ...context, detail: { statusCode: 404 } }
      );
      return { kind: "lot_not_found" };
    }
    const reason = error instanceof Error ? error.message : String(error);
    captureRequiredFieldCheck(
      "skipped",
      "Pending-booking required-field check skipped: ResLab lookup failed",
      {
        ...context,
        detail: {
          reason: reason.slice(0, 300),
          statusCode: error instanceof ReslabError ? error.statusCode : null,
        },
      }
    );
    return { kind: "skipped" };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const parsed = declaredExtraFieldsSchema.safeParse(raw);
  if (!parsed.success) {
    captureRequiredFieldCheck(
      "skipped",
      "Pending-booking required-field check skipped: unexpected extra_fields shape",
      { ...context, detail: { issue: parsed.error.issues[0]?.message ?? "unknown" } }
    );
    return { kind: "skipped" };
  }
  return { kind: "declared", fields: parsed.data };
}

/** Customer-facing suffix on every refusal: staging runs BEFORE the card is confirmed. */
const NOT_CHARGED = "you have not been charged.";

/** Stripe reads and DB writes in direct staging are bounded (4b plan §3.1, §10 F-13). */
const DIRECT_PI_TIMEOUT_MS = 4_000;
const DIRECT_WRITE_TIMEOUT_MS = 3_000;

/** PaymentIntent states a staging call can legitimately see: the card is not confirmed yet. */
const STAGEABLE_PI_STATUSES = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);
/** Already authorized (or further): the booking is being finished — never tell this customer "not charged". */
const AUTHORIZED_PI_STATUSES = new Set(["requires_capture", "processing", "succeeded"]);

const lotRecipientsSchema = z.array(z.string().email()).min(1);

/** The client hands off to /checkout/complete on this (checkout-form, §10 F-9). */
function alreadyAuthorized(piId: string): NextResponse {
  return NextResponse.json(
    { error: "Your payment is authorized — we're finishing your booking.", code: "already_authorized", paymentIntentId: piId },
    { status: 409 }
  );
}

/** Just enough of the body to read the PaymentIntent before anything else. */
const directPiIdSchema = z.object({ stripePaymentIntentId: z.string().startsWith("pi_").max(255) }).passthrough();

const refuse = (status: number, error: string, code?: string) =>
  NextResponse.json({ error, ...(code && { code }) }, { status });

/**
 * DIRECT-lot staging (4b plan §3.1; plan A-29 / B10; surcharge plan §1.5, R4,
 * R5). Fails CLOSED, before the card is confirmed: every refusal here means the
 * customer has not been charged — EXCEPT the 409 `already_authorized`, which
 * exists precisely so an authorized customer is never told that (§9 M-A; the
 * client hands off to /checkout/complete). Nothing is written unless every
 * check passes.
 *
 * Order: PaymentIntent id → PaymentIntent (bounded) → STATE (authorized → 409;
 * cancelled → refuse) → gate → parse (`.strict`) → bind → money (arithmetic
 * only, §9 H-E) → lot read (bounded; the same eligibility and lead-time checks
 * as checkout, §9 M-B) → snapshot + size label → existing booking → a
 * declined attempt's row reopened → terms row → pending row. The state check
 * comes first so no later "not charged" refusal can reach an authorized
 * customer who changed a detail before pressing Pay again.
 *
 * Every amount comes from the PaymentIntent's metadata; the lot read supplies
 * only the snapshot, the size LABEL and the partner terms. The terms row is
 * written first (§10 F-7: an orphan terms row is inert, read only by PI from a
 * booking); the engine refuses to capture without it (§9 M-C).
 */
async function stageDirect(body: unknown, request: NextRequest): Promise<NextResponse> {
  const idOnly = directPiIdSchema.safeParse(body);
  if (!idOnly.success) {
    return refuse(400, `Missing or invalid payment reference — ${NOT_CHARGED}`);
  }
  const piId = idOnly.data.stripePaymentIntentId;

  let pi: Awaited<ReturnType<typeof stripe.paymentIntents.retrieve>>;
  try {
    pi = await stripe.paymentIntents.retrieve(piId, undefined, { timeout: DIRECT_PI_TIMEOUT_MS });
  } catch (error) {
    capturePaymentError(
      new Error(`Direct pending-booking staging: PaymentIntent read failed — ${error instanceof Error ? error.message : String(error)}`),
      { stripePaymentIntentId: piId }
    );
    return refuse(503, `We couldn't reach our payment provider. Please try again — ${NOT_CHARGED}`);
  }
  const meta = pi.metadata ?? {};

  // PaymentIntent state FIRST (§9 M-A, §10 F-9). Authorized = Pay pressed again
  // after a failed finish: the booking is under way — hand off, whatever the
  // body now says. A ResLab PaymentIntent is answered the same way.
  if (AUTHORIZED_PI_STATUSES.has(pi.status)) return alreadyAuthorized(piId);
  if (!STAGEABLE_PI_STATUSES.has(pi.status)) {
    // canceled: the authorization window closed or the payment was released.
    return refuse(400, `This payment has expired. Please go back and start checkout again — ${NOT_CHARGED}`, "payment_not_stageable");
  }

  if (!isDirectCheckoutOpen()) {
    return refuse(503, `Online booking for this lot is not open yet — ${NOT_CHARGED}`, "direct_not_bookable_yet");
  }
  const result = directPendingBookingSchema.safeParse(body);
  if (!result.success) {
    return refuse(400, `${result.error.issues[0].message} — ${NOT_CHARGED}`);
  }
  const payload = result.data;
  const report = (message: string) =>
    capturePaymentError(new Error(`Direct pending-booking staging rejected — ${message}`), {
      stripePaymentIntentId: piId,
      amount: pi.amount / 100,
    });

  // Bind to the PaymentIntent. Unlike the ResLab branch every key is REQUIRED:
  // direct PaymentIntents only ever existed with them.
  const payloadLotId = parseDirectLotUnifiedId(payload.lotId);
  const mismatches: string[] = [];
  if (meta.inventorySource !== "direct") mismatches.push("inventorySource");
  // A ResLab key on a "direct" PaymentIntent is a corrupted or forged payment.
  if (meta.locationId !== undefined) mismatches.push("locationId");
  if (meta.parkingTypeId !== undefined) mismatches.push("parkingTypeId");
  if (meta.lotId !== payload.lotId) mismatches.push("lotId");
  if (payloadLotId === null || meta.directLotId !== String(payloadLotId)) mismatches.push("directLotId");
  if (!meta.customerEmail || meta.customerEmail.trim().toLowerCase() !== payload.customer.email.trim().toLowerCase()) {
    mismatches.push("customerEmail");
  }
  // Literal wall-clock strings, compared exactly — never parsed as a Date.
  if (!meta.checkin || !meta.checkinTime || payload.fromDate !== `${meta.checkin} ${convertTo24Hour(meta.checkinTime)}:00`) {
    mismatches.push("checkin");
  }
  if (!meta.checkout || !meta.checkoutTime || payload.toDate !== `${meta.checkout} ${convertTo24Hour(meta.checkoutTime)}:00`) {
    mismatches.push("checkout");
  }
  if (mismatches.length > 0 || payloadLotId === null) {
    report(`payload does not match PaymentIntent metadata: ${mismatches.join(", ")}`);
    return refuse(400, `Booking details do not match this payment — ${NOT_CHARGED}`);
  }

  // Protection: derived from the PaymentIntent, and the client must agree (as for ResLab).
  const metaProtection = readProtectionMetadata(meta);
  if (metaProtection.kind === "invalid" || metaProtection.kind === "legacy_plan_a") {
    report(`protection metadata ${metaProtection.kind}`);
    return refuse(400, "Your protection selection couldn't be verified — please choose it again. You have not been charged.");
  }
  const protectionPlanCode = metaProtection.kind === "tier" ? metaProtection.code : null;
  if (payload.protectionPlanCode !== protectionPlanCode) {
    report("client protectionPlanCode does not match PaymentIntent metadata");
    return refuse(400, "Your protection selection doesn't match this payment — please choose it again. You have not been charged.");
  }

  // The at-lot vehicle estimate, from the PaymentIntent's own terms (R5).
  const vehicle = directVehicleEstimate(payload.vehicleSize, meta);
  if (!vehicle.ok) {
    if (vehicle.reason === "metadata") {
      report(vehicle.detail);
      return refuse(400, `We couldn't verify this payment's details. Please go back and try again — ${NOT_CHARGED}`);
    }
    return refuse(
      400,
      `That vehicle size isn't offered at this lot any more. Please choose your vehicle size again — ${NOT_CHARGED}`,
      "unknown_vehicle_size"
    );
  }

  // Unreachable while DIRECT_ENGINE_READY is true; kept as the guard for a
  // rollback of that flag (4b plan §9.3 drain).
  if (!DIRECT_ENGINE_READY) {
    return refuse(503, `Online booking for this lot is not open yet — ${NOT_CHARGED}`, "direct_not_bookable_yet");
  }

  // Money: the stamped numbers must agree with each other and with Stripe (§9 H-E).
  const money = readDirectMetadataMoney(meta, pi.amount);
  if (!money.ok) {
    report(`money metadata: ${money.detail}`);
    return refuse(400, `We couldn't verify this payment's amount. Please go back and try again — ${NOT_CHARGED}`);
  }

  // One bounded lot read, with exactly checkout's eligibility rules (sellable
  // here, minimum stay, the lot's notice period in the airport's clock).
  const quoted = await quoteDirectCheckout({
    payloadId: payloadLotId,
    fromDate: payload.fromDate,
    toDate: payload.toDate,
    endpoint: "/api/reservations/pending",
  });
  if (!quoted.ok) {
    if (quoted.status === 503) {
      return refuse(503, `Parking data is temporarily unavailable. Please try again — ${NOT_CHARGED}`);
    }
    if (quoted.status === 404) {
      return refuse(400, `This lot is no longer available to book. Please choose another lot — ${NOT_CHARGED}`, "direct_not_found");
    }
    return refuse(400, `${quoted.error} — ${NOT_CHARGED}`, quoted.code);
  }
  const lot = quoted.lot;
  if (quoted.days !== money.money.days) {
    report(`stay is ${quoted.days} billed days today but the payment was priced for ${money.money.days}`);
    return refuse(400, `Booking details do not match this payment — ${NOT_CHARGED}`);
  }

  const snapshot = buildLotSnapshotV2(lot);
  if (!snapshot) {
    captureBookingError(new Error(`Direct lot ${lot.payloadId} cannot be snapshotted (address/state/zip/coords) — staging refused`), {
      step: "checkout",
    });
    return refuse(503, `This lot can't be booked right now. Please try again later — ${NOT_CHARGED}`);
  }
  const recipients = lotRecipientsSchema.safeParse(lot.notificationEmails);
  if (!recipients.success) {
    captureBookingError(new Error(`Direct lot ${lot.payloadId} has no valid notification email — staging refused`), {
      step: "checkout",
    });
    return refuse(503, `This lot can't be booked right now. Please try again later — ${NOT_CHARGED}`);
  }
  const sizeLabel =
    payload.vehicleSize === NO_OVERSIZED_VEHICLE
      ? NO_OVERSIZED_LABEL
      : lot.vehicleSurcharges.find((v) => v.code === payload.vehicleSize)?.label;
  if (!sizeLabel) {
    return refuse(
      400,
      `That vehicle size isn't offered at this lot any more. Please choose your vehicle size again — ${NOT_CHARGED}`,
      "unknown_vehicle_size"
    );
  }

  // Attribution and identity from the request, never the body (as for ResLab).
  const attribution = readAttributionFromRequest(request, { stripePaymentIntentId: piId });
  const { identity, reason: identityReason } = await sessionIdentityFromRequest();
  if (payload.userId && payload.userId !== (identity?.userId ?? null)) {
    captureBookingError(
      new Error(
        identityReason === "auth_error"
          ? `session unreadable; client userId dropped (booking proceeds as guest) pi=${piId}`
          : identity === null
            ? `client sent a userId but no session cookie was present (stale bundle or signed out) pi=${piId}`
            : `client-supplied userId differs from the session user pi=${piId}`
      ),
      { step: "checkout" }
    );
  }

  const supabase = await createAdminClient();
  const writeSignal = () => AbortSignal.timeout(DIRECT_WRITE_TIMEOUT_MS);
  const cannotPrepare = () => refuse(503, `Could not prepare your booking. Please try again — ${NOT_CHARGED}`);

  // Already fulfilled, or a fulfilment already holds the row: never rewrite it.
  const { data: existingBooking, error: existingError } = await supabase
    .from("bookings")
    .select("id")
    .eq("stripe_payment_intent_id", piId)
    .abortSignal(writeSignal())
    .maybeSingle();
  if (existingError) {
    report(`existing-booking read failed: ${existingError.message}`);
    return cannotPrepare();
  }
  if (existingBooking) return NextResponse.json({ staged: false, reason: "already_booked" });

  const { data: existingRow, error: rowError } = await supabase
    .from("pending_bookings")
    .select("status")
    .eq("stripe_payment_intent_id", piId)
    .abortSignal(writeSignal())
    .maybeSingle();
  if (rowError) {
    report(`pending-row read failed: ${rowError.message}`);
    return cannotPrepare();
  }
  const existingStatus = (existingRow as { status: string } | null)?.status;
  if (existingStatus !== undefined && existingStatus !== "pending") {
    // The PaymentIntent is stageable (checked above): no money is held and no
    // fulfilment can be running — the engine claims only after authorization.
    // A `failed` row is a declined card's: reopen it so the refresh below
    // applies the tier and vehicle size the customer chose for THIS attempt
    // (otherwise the engine reopens it after authorization with the old ones
    // and the lot is told the wrong size). Only a row nothing ever worked on.
    // Any other non-pending row is never "already staged": start again.
    if (existingStatus === "failed") {
      const { data: reopened, error: reopenError } = await supabase
        .from("pending_bookings")
        .update({ status: "pending", last_error: "reopened at re-stage after a declined card" })
        .eq("stripe_payment_intent_id", piId)
        .eq("status", "failed")
        .is("reslab_reservation_number", null)
        .is("claimed_at", null)
        .is("reslab_attempt_started_at", null)
        .select("stripe_payment_intent_id")
        .abortSignal(writeSignal())
        .maybeSingle();
      if (reopenError) {
        report(`declined-row reopen failed: ${reopenError.message}`);
        return cannotPrepare();
      }
      if (!reopened) {
        report("pending row is failed and was worked on before — not reopened; customer asked to start again");
        return refuse(400, `This payment can't be used again. Please go back and start checkout again — ${NOT_CHARGED}`, "payment_not_stageable");
      }
    } else {
      report(`pending row is ${existingStatus} under a stageable PaymentIntent — customer asked to start again`);
      return refuse(400, `This payment can't be used again. Please go back and start checkout again — ${NOT_CHARGED}`, "payment_not_stageable");
    }
  }

  // Terms first (§10 F-7). Stage-owned columns only — never the lot-notice ones.
  const { error: termsError } = await supabase
    .from("direct_booking_terms")
    .upsert(
      {
        stripe_payment_intent_id: piId,
        direct_lot_id: String(lot.payloadId),
        livemode: pi.livemode,
        partner_share_percent: lot.partnerSharePercent,
        // B8: the rate the customer was charged at, not today's CMS value.
        tax_rate_percent: money.money.taxRatePercent,
        tax_collected_by: lot.taxCollectedBy,
        lot_recipients: recipients.data,
      },
      { onConflict: "stripe_payment_intent_id" }
    )
    .abortSignal(writeSignal());
  if (termsError) {
    report(`terms write failed: ${termsError.message}`);
    return cannotPrepare();
  }

  const vehicleColumns = {
    vehicle_size: vehicle.vehicleSize,
    vehicle_size_label: sizeLabel,
    vehicle_surcharge_cents: vehicle.surchargeCents,
    vehicle_surcharge_tax_cents: vehicle.surchargeTaxCents,
    vehicle_size_source: payload.vehicleSizeSource,
  };
  const protectionColumns = {
    has_protection_plan: protectionPlanCode !== null,
    protection_plan_code: protectionPlanCode,
  };
  const m = money.money;
  const { error: insertError } = await supabase
    .from("pending_bookings")
    .insert({
      stripe_payment_intent_id: piId,
      status: "pending",
      inventory_source: "direct",
      direct_lot_id: String(lot.payloadId),
      lot_snapshot: snapshot,
      location_id: null,
      parking_type_id: null,
      costs_token: null,
      from_date: payload.fromDate,
      to_date: payload.toDate,
      customer: payload.customer,
      vehicle: payload.vehicle,
      extra_fields: null,
      // /checkout/complete rebuilds the 3-D Secure return URL from this.
      confirmation_params: payload.confirmationParams ?? null,
      location_name: snapshot.name,
      location_address: snapshotAddressLine(snapshot),
      airport_code: snapshot.airportCode,
      // Dollars, from the PaymentIntent's cents (B8). grand_total excludes the
      // service fee and Park Guard, as on every ResLab row.
      subtotal: m.subtotalCents / 100,
      tax_total: m.taxCents / 100,
      fees_total: 0,
      grand_total: m.grandTotalCents / 100,
      triply_service_fee: m.serviceFeeCents / 100,
      user_id: identity?.userId ?? null,
      ...protectionColumns,
      attribution,
      livemode: pi.livemode,
      ...vehicleColumns,
    })
    .abortSignal(writeSignal());

  if (insertError) {
    if ((insertError as { code?: string }).code !== "23505") {
      report(`pending insert failed: ${insertError.message}`);
      return cannotPrepare();
    }
    // 23505: an earlier Pay on this PaymentIntent (a declined card, a double
    // click). The customer may have changed the tier, the vehicle size (R4) or
    // corrected their name, phone, plate or car since — and for a direct lot
    // this row is the ONLY fulfilment source and the lot notice its only
    // channel, so refresh all of it (email and dates are bound to the
    // PaymentIntent above). Only while the row is `pending` with no number.
    // Fatal on failure: a stale row would tell the lot the wrong car. Zero rows
    // updated = a fulfilment claimed it in between; the stored row stands.
    const { error: refreshError } = await supabase
      .from("pending_bookings")
      .update({
        ...protectionColumns,
        ...vehicleColumns,
        customer: payload.customer,
        vehicle: payload.vehicle,
        confirmation_params: payload.confirmationParams ?? null,
        // Only a session that IS there may replace the staged user: a lapse
        // (sign-out in another tab, a token blip) must never downgrade a
        // signed-in booking to a guest one — direct fulfilment reads this id only.
        ...(identity ? { user_id: identity.userId } : {}),
      })
      .eq("stripe_payment_intent_id", piId)
      .eq("status", "pending")
      .is("reslab_reservation_number", null)
      .abortSignal(writeSignal());
    if (refreshError) {
      report(`re-stage refresh failed: ${refreshError.message}`);
      return cannotPrepare();
    }
    return NextResponse.json({ staged: true, reason: "already_staged" });
  }

  return NextResponse.json({ staged: true });
}
