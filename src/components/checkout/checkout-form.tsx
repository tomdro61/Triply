"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { UnifiedLot } from "@/types/lot";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import {
  CheckoutData,
  CheckoutStep,
  CustomerDetails,
  VehicleDetails,
  PriceBreakdown,
  CheckoutCostData,
  ExtraFieldValue,
} from "@/types/checkout";
import { CheckoutSteps } from "./checkout-steps";
import { CustomerDetailsStep } from "./customer-details-step";
import { VehicleDetailsStep } from "./vehicle-details-step";
import { StripeProvider } from "./stripe-provider";
import { StripePaymentForm } from "./stripe-payment-form";
import { OrderSummary } from "./order-summary";
import { trackBeginCheckout, trackAddPaymentInfo } from "@/lib/analytics/gtag";
import { PROTECTION_PLAN } from "@/lib/parkguard/client";
import { capturePaymentError, captureAPIError } from "@/lib/sentry";

interface CheckoutFormProps {
  lot: UnifiedLot;
  checkIn: string;
  checkOut: string;
  checkInTime: string;
  checkOutTime: string;
  costData?: CheckoutCostData | null;
  fromDate?: string;
  toDate?: string;
}

// Dev mode - skip Stripe payment for testing (only in development)
const DEV_SKIP_PAYMENT =
  process.env.NODE_ENV === "development" &&
  process.env.NEXT_PUBLIC_DEV_SKIP_PAYMENT === "true";

export function CheckoutForm({
  lot,
  checkIn,
  checkOut,
  checkInTime,
  checkOutTime,
  costData,
  fromDate,
  toDate,
}: CheckoutFormProps) {
  const router = useRouter();
  const supabase = createClient();
  const [currentStep, setCurrentStep] = useState<CheckoutStep>("details");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [isCreatingPaymentIntent, setIsCreatingPaymentIntent] = useState(false);

  // Get current user on mount
  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);

      // Pre-fill customer details if user is logged in
      if (user) {
        const nameParts = (user.user_metadata?.full_name || user.user_metadata?.name || "").split(" ");
        setCustomerDetails(prev => ({
          ...prev,
          firstName: nameParts[0] || prev.firstName,
          lastName: nameParts.slice(1).join(" ") || prev.lastName,
          email: user.email || prev.email,
        }));
      }
    };
    getUser();
  }, [supabase.auth]);

  // Form data
  const [customerDetails, setCustomerDetails] = useState<CustomerDetails>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });

  const [vehicleDetails, setVehicleDetails] = useState<VehicleDetails>({
    make: "",
    model: "",
    color: "",
    licensePlate: "",
    state: "",
  });

  // Dynamic extra fields from API
  const [extraFieldValues, setExtraFieldValues] = useState<Record<string, string>>({});

  const [promoCode, setPromoCode] = useState<string | null>(null);
  const [promoDiscountPercent, setPromoDiscountPercent] = useState<number>(0);
  const [serverCostsToken, setServerCostsToken] = useState<string | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // null = customer has not yet decided (required-decision UX). Becomes true
  // or false once they pick a radio on the payment step.
  const [protectionPlanChoice, setProtectionPlanChoice] = useState<boolean | null>(null);
  const [protectionPlanUpdating, setProtectionPlanUpdating] = useState(false);
  // Toggle errors are kept SEPARATE from submitError so the StripePaymentForm
  // doesn't render them under the "Payment Error" heading (which is reserved
  // for actual Stripe / booking failures).
  const [protectionToggleError, setProtectionToggleError] = useState<string | null>(null);
  // Set when a network error makes the server-side PaymentIntent state
  // unknown — the fetch rejected but Stripe may have already processed the
  // update on the server. Submit must be blocked in this state because the
  // customer's visible choice may diverge from what they'd actually be
  // charged; the only way out is for them to re-toggle (which fires a
  // fresh update-pi and reconciles state) or refresh the page.
  const [protectionStateAmbiguous, setProtectionStateAmbiguous] = useState(false);
  // Sequence ID for in-flight update-pi requests. Each click increments;
  // responses that arrive after a newer click are discarded so they can't
  // clobber the latest state. Prevents the rapid-toggle race condition.
  const inflightToggleId = useRef(0);
  const hasProtectionPlan = protectionPlanChoice === true;

  // Validation errors
  const [customerErrors, setCustomerErrors] = useState<
    Partial<Record<keyof CustomerDetails, string>>
  >({});
  const [vehicleErrors, setVehicleErrors] = useState<
    Partial<Record<keyof VehicleDetails, string>>
  >({});

  // Calculate price breakdown using API data when available
  const priceBreakdown = useMemo<PriceBreakdown>(() => {
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const calculatedDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

    const protectionPlan = hasProtectionPlan ? PROTECTION_PLAN.price : 0;

    // Use API data if available
    if (costData) {
      const days = costData.numberOfDays || calculatedDays;
      // Roll fees into the daily rate so it matches the search page
      const baseWithFees = costData.subtotal + costData.feesTotal;
      const dailyRate = baseWithFees / days;

      // Apply promo discount using server-validated percentage
      const discount = costData.subtotal * (promoDiscountPercent / 100);

      const serviceFee = costData.serviceFee || 0;

      return {
        dailyRate,
        days,
        subtotal: baseWithFees,
        discount,
        taxes: costData.taxTotal,
        fees: 0,
        serviceFee,
        protectionPlan,
        total: costData.grandTotal + serviceFee + protectionPlan - discount,
        // Server clamps with Math.max(0, ...) before charging Stripe; mirror
        // it client-side so a large promo doesn't render a negative "Due Now".
        dueNow: Math.max(0, costData.dueNow + protectionPlan - discount),
        dueAtLocation: costData.dueAtLocation,
      };
    }

    // Fallback calculation
    const dailyRate = lot.pricing?.minPrice ?? 0;
    const subtotal = dailyRate * calculatedDays;

    // Apply promo discount using server-validated percentage
    const discount = subtotal * (promoDiscountPercent / 100);

    const afterDiscount = subtotal - discount;
    const taxes = Math.round(afterDiscount * 0.08 * 100) / 100; // 8% tax
    const total = afterDiscount + taxes + protectionPlan;

    return {
      dailyRate,
      days: calculatedDays,
      subtotal,
      discount,
      taxes,
      fees: 0,
      serviceFee: 0,
      protectionPlan,
      total,
      dueNow: total,
      dueAtLocation: 0,
    };
  }, [checkIn, checkOut, lot.pricing?.minPrice, promoDiscountPercent, costData, hasProtectionPlan]);

  // Validation functions
  const validateCustomerDetails = (): boolean => {
    const errors: Partial<Record<keyof CustomerDetails, string>> = {};

    if (!customerDetails.firstName.trim()) {
      errors.firstName = "First name is required";
    }
    if (!customerDetails.lastName.trim()) {
      errors.lastName = "Last name is required";
    }
    if (!customerDetails.email.trim()) {
      errors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerDetails.email)) {
      errors.email = "Please enter a valid email";
    }
    if (!customerDetails.phone.trim()) {
      errors.phone = "Phone number is required";
    }

    setCustomerErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const validateVehicleDetails = (): boolean => {
    const errors: Partial<Record<keyof VehicleDetails, string>> = {};

    if (!vehicleDetails.make.trim()) {
      errors.make = "Make is required";
    }
    if (!vehicleDetails.model.trim()) {
      errors.model = "Model is required";
    }
    if (!vehicleDetails.color) {
      errors.color = "Color is required";
    }
    if (!vehicleDetails.licensePlate.trim()) {
      errors.licensePlate = "License plate is required";
    }
    if (!vehicleDetails.state) {
      errors.state = "State is required";
    }

    setVehicleErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Step handlers
  const handleCustomerNext = () => {
    if (validateCustomerDetails()) {
      setSubmitError(null); // Clear any previous errors
      setCurrentStep("vehicle");
    }
  };

  const handleVehicleNext = async () => {
    if (!validateVehicleDetails()) return;

    // In dev mode, skip payment intent creation
    if (DEV_SKIP_PAYMENT) {
      setCurrentStep("payment");
      return;
    }

    // Create PaymentIntent with server-verified price
    setIsCreatingPaymentIntent(true);
    try {
      const parkingTypeId = costData?.parkingTypeId || lot.pricing?.parkingTypes?.[0]?.id;
      if (!parkingTypeId || !lot.reslabLocationId) {
        throw new Error("Missing required lot data for payment");
      }

      // Initial PaymentIntent is parking-only — protection decision is
      // deferred to the payment step, where /api/checkout/lot/update-pi
      // flexes the amount once the customer picks Yes/No.
      // hasProtectionPlan is explicitly false here (not omitted): the
      // schema is required at the API boundary, and explicit-false matches
      // the server-side parking-only PI path. Avoiding undefined keeps the
      // silent-default anti-pattern away from this money-handling POST.
      const response = await fetch("/api/checkout/lot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lotId: lot.id,
          locationId: lot.reslabLocationId,
          checkin: checkIn,
          checkout: checkOut,
          checkinTime: checkInTime,
          checkoutTime: checkOutTime,
          parkingTypeId,
          customerEmail: customerDetails.email,
          hasProtectionPlan: false,
          ...(promoCode && { promoCode }),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to initialize payment");
      }

      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
      if (data.costsToken) {
        setServerCostsToken(data.costsToken);
      }
      setCurrentStep("payment");
      trackBeginCheckout({ lotId: lot.id, lotName: lot.name, total: priceBreakdown.total });
      trackAddPaymentInfo({ lotId: lot.id, lotName: lot.name, total: priceBreakdown.total });
    } catch (error) {
      console.error("PaymentIntent creation error:", error);
      setSubmitError(
        error instanceof Error ? error.message : "Failed to initialize payment"
      );
    } finally {
      setIsCreatingPaymentIntent(false);
    }
  };

  const handleVehicleBack = () => {
    setCurrentStep("details");
  };

  const handlePaymentBack = () => {
    // Invalidate any in-flight update-pi toggle from the prior PI so its
    // resolution can't clobber fresh state on the new PI created after
    // navigation. The sequence-ID stale-discard guard inside
    // doProtectionPlanUpdate will short-circuit when myId !== current.
    inflightToggleId.current += 1;
    setProtectionPlanUpdating(false);
    // Clear the existing PaymentIntent state so re-entering the payment step
    // creates a fresh PI. Otherwise a customer who toggles protection while
    // back on the vehicle step could end up paying the old (stale) amount.
    setClientSecret(null);
    setPaymentIntentId(null);
    setProtectionPlanChoice(null);
    setProtectionToggleError(null);
    setProtectionStateAmbiguous(false);
    setCurrentStep("vehicle");
  };

  // Protection-plan choice handler — fires server-side PI update so Stripe
  // charges the right amount on Pay Now. Optimistically updates the UI; rolls
  // back on failure. Race-protected via sequence ID so rapid Yes/No clicks
  // can't land out of order. Errors route to protectionToggleError (separate
  // from submitError) so the wrong heading doesn't surface in the UI.
  //
  // The sync wrapper increments the sequence ID and captures `myId` BEFORE
  // any await scheduling — guarantees serialization even under stress (e.g.,
  // synthetic Playwright double-clicks) where two event handlers might race.
  const handleProtectionPlanChange = (selected: boolean) => {
    if (!paymentIntentId) {
      // Dev-mode (no PI created) — local state only. Should never happen in
      // production because StripePaymentForm only renders when clientSecret
      // exists. Log if it does so we catch any future regression.
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "handleProtectionPlanChange called without paymentIntentId (DEV_SKIP_PAYMENT?)"
        );
      }
      setProtectionPlanChoice(selected);
      return;
    }
    inflightToggleId.current += 1;
    const myId = inflightToggleId.current;
    void doProtectionPlanUpdate(selected, myId, paymentIntentId);
  };

  const doProtectionPlanUpdate = async (
    selected: boolean,
    myId: number,
    piId: string
  ) => {
    const previous = protectionPlanChoice;
    setProtectionPlanChoice(selected);
    setProtectionPlanUpdating(true);
    setProtectionToggleError(null);
    setProtectionStateAmbiguous(false);

    let response: Response | null = null;
    let errorMessage: string | null = null;
    let networkAmbiguous = false;
    let shouldCaptureSentry = false;

    try {
      response = await fetch("/api/checkout/lot/update-pi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentId: piId, hasProtectionPlan: selected }),
      });

      if (!response.ok) {
        let serverMsg = "";
        try {
          const data = await response.json();
          serverMsg = data?.error || "";
        } catch {
          /* body wasn't JSON */
        }
        if (response.status === 422) {
          errorMessage =
            serverMsg ||
            "Couldn't update protection — please go back and restart checkout";
        } else if (response.status === 409) {
          errorMessage =
            "Payment is already in progress — refresh the page and try again";
        } else {
          errorMessage =
            serverMsg || "Couldn't update protection — please try again";
          // 400 (Zod validation) or 5xx — ops should know about regressions
          // and outages even if the user-facing message is generic.
          if (response.status === 400 || response.status >= 500) {
            shouldCaptureSentry = true;
          }
        }
      }
    } catch (networkErr) {
      capturePaymentError(
        networkErr instanceof Error
          ? networkErr
          : new Error(String(networkErr)),
        { stripePaymentIntentId: piId, amount: PROTECTION_PLAN.price }
      );
      // Network rejection means we don't know whether Stripe applied the
      // update server-side. Rolling back the UI choice while Stripe holds
      // the new amount would let the customer click Pay Now believing they're
      // being charged one amount and then be charged another — the mismatch
      // would only surface as a 400 from /api/reservations after the card
      // was already charged. Mark the state ambiguous and block submit
      // until the customer re-toggles (forces a fresh update-pi and
      // resolves the state).
      networkAmbiguous = true;
      errorMessage =
        "Couldn't confirm the protection update — please toggle Yes/No again to verify your total before paying";
    }

    if (shouldCaptureSentry && response) {
      capturePaymentError(
        new Error(
          `update-pi returned ${response.status}: ${errorMessage || "unknown"}`
        ),
        { stripePaymentIntentId: piId, amount: PROTECTION_PLAN.price }
      );
    }

    // Stale response? A newer click superseded this request; discard the
    // result so it can't clobber fresh state. The newer call will set
    // protectionPlanUpdating to false when it completes.
    if (myId !== inflightToggleId.current) {
      return;
    }

    if (errorMessage !== null) {
      if (networkAmbiguous) {
        // Keep the optimistic choice — server may have applied it. Block
        // submit via the ambiguous flag until the next toggle resolves state.
        setProtectionStateAmbiguous(true);
      } else {
        // HTTP error from the server is an explicit "didn't apply" — safe
        // to roll back to the previous choice.
        setProtectionPlanChoice(previous);
      }
      setProtectionToggleError(errorMessage);
    }
    setProtectionPlanUpdating(false);
  };

  // Promo code handlers — validates server-side. Returns a discriminated
  // result so the PromoCode widget can show distinct messages for "invalid
  // code" vs "couldn't reach server" — the latter is misleading if shown as
  // "invalid promo code".
  const handleApplyPromo = async (
    code: string
  ): Promise<{ ok: true } | { ok: false; reason: "invalid" | "network" }> => {
    try {
      const response = await fetch("/api/promo/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        // 4xx — server rejected the code (validation, rate limit, auth).
        // Customer should see "invalid", not "retry".
        // 5xx — server fault. Customer sees "retry"; ops sees Sentry alert.
        if (response.status >= 500) {
          captureAPIError(
            new Error(`/api/promo/validate returned ${response.status}`),
            {
              endpoint: "/api/promo/validate",
              method: "POST",
              statusCode: response.status,
            }
          );
          return { ok: false, reason: "network" };
        }
        return { ok: false, reason: "invalid" };
      }
      const data = await response.json();
      if (data.valid) {
        setPromoCode(code);
        setPromoDiscountPercent(data.discountPercent);
        return { ok: true };
      }
      return { ok: false, reason: "invalid" };
    } catch (err) {
      // True fetch rejection — network failure, offline, CORS, abort.
      captureAPIError(err instanceof Error ? err : new Error(String(err)), {
        endpoint: "/api/promo/validate",
        method: "POST",
      });
      return { ok: false, reason: "network" };
    }
  };

  const handleRemovePromo = () => {
    setPromoCode(null);
    setPromoDiscountPercent(0);
  };

  /**
   * The booking payload. Built once and used for BOTH the pre-payment staging
   * call and the post-payment fulfilment call, so the durable row and the live
   * request can never describe different bookings.
   */
  const buildReservationBody = (stripePaymentIntentId: string) => {
    const parkingTypeId =
      costData?.parkingTypeId || lot.pricing?.parkingTypes?.[0]?.id;
    const extraFields: Record<string, string> = { ...extraFieldValues };

    return {
      locationId: lot.reslabLocationId,
      costsToken: serverCostsToken || costData?.costsToken,
      fromDate: fromDate,
      toDate: toDate,
      parkingTypeId: parkingTypeId,
      customer: customerDetails,
      vehicle: vehicleDetails,
      extraFields,
      // Location info for Supabase
      locationName: lot.name,
      locationAddress: `${lot.address}, ${lot.city}, ${lot.state}`,
      airportCode: lot.id.split("-")[0]?.toUpperCase() || "",
      // Pricing info
      subtotal: costData?.subtotal || priceBreakdown.subtotal,
      taxTotal: costData?.taxTotal || priceBreakdown.taxes,
      feesTotal: costData?.feesTotal || priceBreakdown.fees,
      grandTotal: costData?.grandTotal || priceBreakdown.total,
      triplyServiceFee: priceBreakdown.serviceFee,
      // User ID for linking to account (if logged in)
      userId: user?.id || null,
      // Park Guard parking protection opt-in. Sent explicitly (not
      // conditionally omitted) so the API boundary sees an unambiguous
      // boolean — avoids the "silent default" anti-pattern from CLAUDE.md.
      hasProtectionPlan,
      // Stripe payment reference
      stripePaymentIntentId,
    };
  };

  /** Query params needed to rebuild this customer's confirmation URL on the
   *  redirect-return path, where none of the above client state still exists. */
  const confirmationParams = () => ({
    lot: lot.id,
    checkin: checkIn,
    checkout: checkOut,
    checkinTime: checkInTime,
    checkoutTime: checkOutTime,
    serviceFee: String(priceBreakdown.serviceFee),
  });

  /**
   * Persist the booking payload BEFORE the card is confirmed.
   *
   * THROWS on any failure, which aborts the payment. That is deliberate: a
   * customer redirected to their bank for 3-D Secure never returns to this tab,
   * so without a durable row the webhook has nothing to fulfil from and the
   * charge becomes an orphan. Blocking checkout is the strictly better failure.
   */
  const stagePendingBooking = async (stripePaymentIntentId: string) => {
    // fetch() does NOT reject on 4xx/5xx — the status must be checked explicitly
    // or a failed stage would silently let the charge proceed.
    const response = await fetch("/api/reservations/pending", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...buildReservationBody(stripePaymentIntentId),
        confirmationParams: confirmationParams(),
      }),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(
        detail?.error ||
          "We couldn't prepare your booking. Please try again — you have not been charged."
      );
    }
  };

  // Handle successful Stripe payment - then create ResLab reservation
  const handlePaymentSuccess = async (stripePaymentIntentId: string) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const response = await fetch("/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildReservationBody(stripePaymentIntentId)),
      });

      const result = await response.json();

      // 202 = another path (the webhook) is completing this booking, or the
      // payment is still settling. Hand off to /checkout/complete, which polls
      // until the reservation exists rather than showing a false failure.
      if (response.status === 202) {
        sessionStorage.setItem(`lot-${lot.id}`, JSON.stringify(lot));
        router.push(`/checkout/complete?payment_intent=${encodeURIComponent(stripePaymentIntentId)}`);
        return;
      }

      if (!response.ok) {
        throw new Error(result.error || "Failed to create reservation");
      }

      // Store lot data for confirmation page
      sessionStorage.setItem(`lot-${lot.id}`, JSON.stringify(lot));

      // Redirect to confirmation page
      router.push(
        `/confirmation/${result.reservation.reservationNumber}?lot=${lot.id}&checkin=${checkIn}&checkout=${checkOut}&checkinTime=${encodeURIComponent(checkInTime)}&checkoutTime=${encodeURIComponent(checkOutTime)}&serviceFee=${priceBreakdown.serviceFee}&email=${encodeURIComponent(customerDetails.email)}`
      );
    } catch (error) {
      console.error("Reservation error after payment:", error);
      setSubmitError(
        error instanceof Error ? error.message : "Payment succeeded but reservation failed. Please contact support."
      );
      setIsSubmitting(false);
    }
  };

  // Submit booking (dev mode - no Stripe payment)
  const handleSubmit = async () => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Get parking type ID from costData or lot pricing
      const parkingTypeId = costData?.parkingTypeId || lot.pricing?.parkingTypes?.[0]?.id;

      // Check if we have the required data for ResLab reservation
      const canCreateResLabReservation =
        lot.reslabLocationId &&
        costData?.costsToken &&
        parkingTypeId;

      if (!canCreateResLabReservation) {
        if (DEV_SKIP_PAYMENT) {
          // Dev mode without full API data - create mock confirmation
          console.log("[DEV MODE] Creating mock reservation (missing costsToken or parkingTypeId)");
          const confirmationId = `TRP-${Date.now().toString(36).toUpperCase()}`;

          // Store lot data for confirmation page (in case lot ID isn't in mock data)
          sessionStorage.setItem(`lot-${lot.id}`, JSON.stringify(lot));

          router.push(
            `/confirmation/${confirmationId}?lot=${lot.id}&checkin=${checkIn}&checkout=${checkOut}&checkinTime=${encodeURIComponent(checkInTime)}&checkoutTime=${encodeURIComponent(checkOutTime)}&serviceFee=${priceBreakdown.serviceFee}&email=${encodeURIComponent(customerDetails.email)}`
          );
          return;
        }

        // Production mode - missing required data
        throw new Error("Unable to complete booking. Please try again.");
      }

      // In dev mode, skip Stripe payment and go straight to ResLab
      if (DEV_SKIP_PAYMENT) {
        console.log("[DEV MODE] Skipping Stripe payment, creating ResLab reservation directly");
      }

      // Build extra fields for API
      const extraFields: Record<string, string> = { ...extraFieldValues };

      // Create reservation via API
      const response = await fetch("/api/reservations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          locationId: lot.reslabLocationId,
          costsToken: costData.costsToken,
          fromDate: fromDate,
          toDate: toDate,
          parkingTypeId: parkingTypeId,
          customer: customerDetails,
          vehicle: vehicleDetails,
          extraFields,
          // Location info for Supabase
          locationName: lot.name,
          locationAddress: `${lot.address}, ${lot.city}, ${lot.state}`,
          airportCode: lot.id.split("-")[0]?.toUpperCase() || "",
          // Pricing info
          subtotal: costData.subtotal || priceBreakdown.subtotal,
          taxTotal: costData.taxTotal || priceBreakdown.taxes,
          feesTotal: costData.feesTotal || priceBreakdown.fees,
          grandTotal: costData.grandTotal || priceBreakdown.total,
          triplyServiceFee: priceBreakdown.serviceFee,
          // User ID for linking to account (if logged in)
          userId: user?.id || null,
          // Park Guard parking protection opt-in. Sent explicitly (not
          // conditionally omitted) so the API boundary sees an unambiguous
          // boolean — avoids the "silent default" anti-pattern from CLAUDE.md.
          hasProtectionPlan,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to create reservation");
      }

      // Store lot data for confirmation page (in case lot ID isn't in mock data)
      sessionStorage.setItem(`lot-${lot.id}`, JSON.stringify(lot));

      // Redirect to confirmation page with reservation number
      router.push(
        `/confirmation/${result.reservation.reservationNumber}?lot=${lot.id}&checkin=${checkIn}&checkout=${checkOut}&checkinTime=${encodeURIComponent(checkInTime)}&checkoutTime=${encodeURIComponent(checkOutTime)}&serviceFee=${priceBreakdown.serviceFee}&email=${encodeURIComponent(customerDetails.email)}`
      );
    } catch (error) {
      console.error("Reservation error:", error);
      setSubmitError(
        error instanceof Error ? error.message : "Failed to complete booking"
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      {/* Main Form */}
      <div className="lg:col-span-2">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 sm:p-8">
          <CheckoutSteps currentStep={currentStep} />

          {currentStep === "details" && (
            <CustomerDetailsStep
              data={customerDetails}
              onChange={setCustomerDetails}
              onNext={handleCustomerNext}
              errors={customerErrors}
            />
          )}

          {currentStep === "vehicle" && (
            <>
              <VehicleDetailsStep
                data={vehicleDetails}
                onChange={setVehicleDetails}
                onNext={handleVehicleNext}
                onBack={handleVehicleBack}
                errors={vehicleErrors}
                extraFields={lot.extraFields}
                extraFieldValues={extraFieldValues}
                onExtraFieldChange={(name, value) =>
                  setExtraFieldValues((prev) => ({ ...prev, [name]: value }))
                }
                isLoading={isCreatingPaymentIntent}
              />
              {submitError && (
                <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-700 text-sm">{submitError}</p>
                </div>
              )}
            </>
          )}

          {currentStep === "payment" && (
            DEV_SKIP_PAYMENT ? (
              // Dev mode: skip payment, create reservation directly
              <div className="space-y-6">
                <div className="bg-purple-100 border border-purple-300 rounded-lg p-3 flex items-center gap-2">
                  <div className="bg-purple-500 text-white text-xs font-bold px-2 py-0.5 rounded">
                    DEV MODE
                  </div>
                  <p className="text-purple-800 text-sm">
                    Stripe payment is bypassed. Reservation will be created directly.
                  </p>
                </div>
                {submitError && (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                    <p className="text-red-700 text-sm">{submitError}</p>
                  </div>
                )}
                <div className="flex gap-4">
                  <button
                    type="button"
                    onClick={handlePaymentBack}
                    disabled={isSubmitting}
                    className="flex items-center justify-center px-6 py-3 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                    className="flex-1 bg-brand-orange text-white font-bold py-3.5 rounded-lg hover:bg-orange-600 transition-all shadow-md disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isSubmitting ? "Creating Reservation..." : `Complete Booking (Dev) - $${priceBreakdown.total.toFixed(2)}`}
                  </button>
                </div>
              </div>
            ) : clientSecret ? (
              <StripeProvider clientSecret={clientSecret}>
                <StripePaymentForm
                  priceBreakdown={priceBreakdown}
                  acceptedTerms={acceptedTerms}
                  onTermsChange={setAcceptedTerms}
                  onBack={handlePaymentBack}
                  onPaymentSuccess={handlePaymentSuccess}
                  onBeforeConfirm={
                    paymentIntentId
                      ? () => stagePendingBooking(paymentIntentId)
                      : undefined
                  }
                  isSubmitting={isSubmitting}
                  submitError={submitError}
                  dueAtLocation={lot.dueAtLocation}
                  protectionPlanChoice={protectionPlanChoice}
                  onProtectionPlanChange={handleProtectionPlanChange}
                  protectionPlanUpdating={protectionPlanUpdating}
                  protectionToggleError={protectionToggleError}
                  protectionStateAmbiguous={protectionStateAmbiguous}
                />
              </StripeProvider>
            ) : (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-orange mx-auto mb-4" />
                <p className="text-gray-500">Initializing payment...</p>
              </div>
            )
          )}
        </div>
      </div>

      {/* Order Summary Sidebar */}
      <div className="lg:col-span-1">
        <OrderSummary
          lot={lot}
          checkIn={checkIn}
          checkOut={checkOut}
          priceBreakdown={priceBreakdown}
          promoCode={promoCode}
          onApplyPromo={handleApplyPromo}
          onRemovePromo={handleRemovePromo}
          // Lock promo once the PaymentIntent exists. Promos applied on the
          // payment step would update the displayed total but NOT the
          // already-frozen PI amount, so Stripe would charge the wrong total.
          promoLocked={clientSecret !== null}
        />
      </div>
    </div>
  );
}
