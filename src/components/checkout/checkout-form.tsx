"use client";

import { useState, useMemo, useEffect } from "react";
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
import { PaymentStep } from "./payment-step";
import { StripeProvider } from "./stripe-provider";
import { StripePaymentForm } from "./stripe-payment-form";
import { OrderSummary } from "./order-summary";

interface CheckoutFormProps {
  lot: UnifiedLot;
  checkIn: string;
  checkOut: string;
  checkInTime?: string;
  checkOutTime?: string;
  costData?: CheckoutCostData | null;
  fromDate?: string;
  toDate?: string;
}

// Demo promo codes
const PROMO_CODES: Record<string, number> = {
  SAVE10: 0.1, // 10% off
  SAVE20: 0.2, // 20% off
  TRIPLY: 0.15, // 15% off
};

// Dev mode - skip Stripe payment for testing
const DEV_SKIP_PAYMENT = process.env.NEXT_PUBLIC_DEV_SKIP_PAYMENT === "true";

export function CheckoutForm({
  lot,
  checkIn,
  checkOut,
  checkInTime = "10:00 AM",
  checkOutTime = "2:00 PM",
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
  const [acceptedTerms, setAcceptedTerms] = useState(false);

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

    // Use API data if available
    if (costData) {
      const days = costData.numberOfDays || calculatedDays;
      const dailyRate = costData.subtotal / days;

      // Apply promo discount (note: in production, promo would be applied via API)
      const discountPercent = promoCode ? PROMO_CODES[promoCode] || 0 : 0;
      const discount = costData.subtotal * discountPercent;

      return {
        dailyRate,
        days,
        subtotal: costData.subtotal,
        discount,
        taxes: costData.taxTotal,
        fees: costData.feesTotal,
        total: costData.grandTotal - discount,
        dueNow: costData.dueNow - discount,
        dueAtLocation: costData.dueAtLocation,
      };
    }

    // Fallback calculation
    const dailyRate = lot.pricing?.minPrice ?? 0;
    const subtotal = dailyRate * calculatedDays;

    // Apply promo discount
    const discountPercent = promoCode ? PROMO_CODES[promoCode] || 0 : 0;
    const discount = subtotal * discountPercent;

    const afterDiscount = subtotal - discount;
    const taxes = Math.round(afterDiscount * 0.08 * 100) / 100; // 8% tax
    const total = afterDiscount + taxes;

    return {
      dailyRate,
      days: calculatedDays,
      subtotal,
      discount,
      taxes,
      fees: 0,
      total,
      dueNow: total,
      dueAtLocation: 0,
    };
  }, [checkIn, checkOut, lot.pricing?.minPrice, promoCode, costData]);

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

    // Create PaymentIntent for Stripe
    setIsCreatingPaymentIntent(true);
    try {
      const amount = priceBreakdown.dueNow || priceBreakdown.total;
      const response = await fetch("/api/payment-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          lotName: lot.name,
          lotId: lot.id,
          checkIn,
          checkOut,
          customerEmail: customerDetails.email,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to initialize payment");
      }

      setClientSecret(data.clientSecret);
      setPaymentIntentId(data.paymentIntentId);
      setCurrentStep("payment");
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
    setCurrentStep("vehicle");
  };

  // Promo code handlers
  const handleApplyPromo = async (code: string): Promise<boolean> => {
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (PROMO_CODES[code]) {
      setPromoCode(code);
      return true;
    }
    return false;
  };

  const handleRemovePromo = () => {
    setPromoCode(null);
  };

  // Handle successful Stripe payment - then create ResLab reservation
  const handlePaymentSuccess = async (stripePaymentIntentId: string) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Get parking type ID from costData or lot pricing
      const parkingTypeId = costData?.parkingTypeId || lot.pricing?.parkingTypes?.[0]?.id;

      // Build extra fields for API
      const extraFields: Record<string, string> = { ...extraFieldValues };

      // Create reservation via API
      const response = await fetch("/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId: lot.reslabLocationId,
          costsToken: costData?.costsToken,
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
          // User ID for linking to account (if logged in)
          userId: user?.id || null,
          // Stripe payment reference
          stripePaymentIntentId,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to create reservation");
      }

      // Store lot data for confirmation page
      sessionStorage.setItem(`lot-${lot.id}`, JSON.stringify(lot));

      // Redirect to confirmation page
      router.push(
        `/confirmation/${result.reservation.reservationNumber}?lot=${lot.id}&checkin=${checkIn}&checkout=${checkOut}&checkinTime=${encodeURIComponent(checkInTime)}&checkoutTime=${encodeURIComponent(checkOutTime)}`
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
            `/confirmation/${confirmationId}?lot=${lot.id}&checkin=${checkIn}&checkout=${checkOut}&checkinTime=${encodeURIComponent(checkInTime)}&checkoutTime=${encodeURIComponent(checkOutTime)}`
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
          feesTotal: costData.feesTotal || priceBreakdown.serviceFee,
          grandTotal: costData.grandTotal || priceBreakdown.total,
          // User ID for linking to account (if logged in)
          userId: user?.id || null,
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
        `/confirmation/${result.reservation.reservationNumber}?lot=${lot.id}&checkin=${checkIn}&checkout=${checkOut}&checkinTime=${encodeURIComponent(checkInTime)}&checkoutTime=${encodeURIComponent(checkOutTime)}`
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
          )}

          {currentStep === "payment" && (
            DEV_SKIP_PAYMENT ? (
              <PaymentStep
                priceBreakdown={priceBreakdown}
                acceptedTerms={acceptedTerms}
                onTermsChange={setAcceptedTerms}
                onBack={handlePaymentBack}
                onSubmit={handleSubmit}
                isSubmitting={isSubmitting}
                submitError={submitError}
                dueAtLocation={lot.dueAtLocation}
              />
            ) : clientSecret ? (
              <StripeProvider clientSecret={clientSecret}>
                <StripePaymentForm
                  priceBreakdown={priceBreakdown}
                  acceptedTerms={acceptedTerms}
                  onTermsChange={setAcceptedTerms}
                  onBack={handlePaymentBack}
                  onPaymentSuccess={handlePaymentSuccess}
                  isSubmitting={isSubmitting}
                  submitError={submitError}
                  dueAtLocation={lot.dueAtLocation}
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
        />
      </div>
    </div>
  );
}
