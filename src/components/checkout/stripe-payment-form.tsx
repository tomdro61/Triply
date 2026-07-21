"use client";

import { useState } from "react";
import {
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import {
  Lock,
  ChevronLeft,
  Loader2,
  Check,
  AlertCircle,
  Wallet,
} from "lucide-react";
import { PriceBreakdown } from "@/types/checkout";
import { ProtectionPlan } from "./protection-plan";

interface StripePaymentFormProps {
  priceBreakdown: PriceBreakdown;
  acceptedTerms: boolean;
  onTermsChange: (accepted: boolean) => void;
  onBack: () => void;
  onPaymentSuccess: (paymentIntentId: string) => Promise<void>;
  /**
   * Persists the booking payload server-side BEFORE the charge is confirmed.
   *
   * Must THROW to abort the payment. A durable pending row is a hard
   * precondition for taking money: PaymentIntent metadata cannot reconstruct a
   * ResLab reservation (no vehicle, no name, no phone), so without the row a
   * customer whose browser dies mid-redirect cannot be fulfilled by the webhook
   * — which is precisely the orphan this rehaul exists to eliminate.
   */
  onBeforeConfirm?: () => Promise<void>;
  isSubmitting?: boolean;
  submitError?: string | null;
  dueAtLocation?: boolean;
  /** null = customer hasn't picked yet (Pay Now stays disabled). */
  protectionPlanChoice: boolean | null;
  onProtectionPlanChange: (selected: boolean) => void;
  protectionPlanUpdating?: boolean;
  /**
   * Error from a failed protection-toggle update. Distinct from `submitError`
   * (payment / booking errors) so the UI can render them under different
   * headings — toggle failures are not "Payment Errors".
   */
  protectionToggleError?: string | null;
  /**
   * Set when a network error left the server-side PaymentIntent state
   * unknown. Submit must stay disabled — the visible choice may not match
   * what Stripe will charge. Re-toggling resolves it.
   */
  protectionStateAmbiguous?: boolean;
}

export function StripePaymentForm({
  priceBreakdown,
  acceptedTerms,
  onTermsChange,
  onBack,
  onPaymentSuccess,
  onBeforeConfirm,
  isSubmitting = false,
  submitError,
  dueAtLocation = false,
  protectionPlanChoice,
  onProtectionPlanChange,
  protectionPlanUpdating = false,
  protectionToggleError = null,
  protectionStateAmbiguous = false,
}: StripePaymentFormProps) {
  const protectionAnswered = protectionPlanChoice !== null;
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const processing = isProcessing || isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements || !acceptedTerms || !protectionAnswered || processing || protectionPlanUpdating || protectionStateAmbiguous) {
      return;
    }

    setIsProcessing(true);
    setPaymentError(null);

    try {
      // Stage the booking payload BEFORE confirming. Deliberately inside the
      // try and immediately before confirmPayment: if staging fails we throw and
      // never charge the card. A checkout the customer can retry is recoverable;
      // a charge with no durable record of what they bought is not.
      if (onBeforeConfirm) {
        await onBeforeConfirm();
      }

      // Confirm the payment
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/checkout/complete`,
        },
        redirect: "if_required",
      });

      if (error) {
        // Payment failed
        setPaymentError(error.message || "Payment failed. Please try again.");
        setIsProcessing(false);
        return;
      }

      if (
        paymentIntent &&
        (paymentIntent.status === "succeeded" ||
          paymentIntent.status === "processing" ||
          paymentIntent.status === "requires_capture")
      ) {
        // Payment authorized — create the reservation.
        //
        // "requires_capture" is the NORMAL success state under manual capture:
        // the customer's card is authorized but NOT charged. Money moves only
        // after ResLab confirms a reservation exists (see
        // @/lib/booking/create-booking). Omitting it here would show a working
        // authorization as a failure and drive the retry-into-double-charge
        // spiral this rehaul exists to end.
        //
        // "processing" is kept for async settlement (some wallets and
        // bank-backed methods): the money is authorized or settling. Telling the
        // customer it failed made them retry, producing a second charge or, if
        // they gave up, a paid-but-no-booking orphan. On this path all side
        // effects are deferred to the webhook, which drives the whole sequence
        // once the PaymentIntent becomes capturable.
        await onPaymentSuccess(paymentIntent.id);
      } else if (paymentIntent && paymentIntent.status === "requires_action") {
        // 3D Secure or other authentication required
        setPaymentError("Additional authentication required. Please try again.");
        setIsProcessing(false);
      } else {
        setPaymentError("Payment could not be processed. Please try again.");
        setIsProcessing(false);
      }
    } catch (err) {
      console.error("Payment error:", err);
      // Surface the thrown message. onBeforeConfirm deliberately throws
      // "…you have not been charged" — the whole point of failing closed before
      // the charge is telling the customer that, and a generic string erased it,
      // conflating a pre-charge abort with a post-charge failure.
      setPaymentError(
        err instanceof Error
          ? err.message
          : "An unexpected error occurred. Please try again."
      );
      setIsProcessing(false);
    }
  };

  // Determine amount to show on button
  const buttonAmount =
    dueAtLocation && priceBreakdown.dueAtLocation > 0
      ? priceBreakdown.dueNow
      : priceBreakdown.total;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900 mb-1">Payment</h2>
        <p className="text-gray-500 text-sm">
          Your payment information is secure and encrypted
        </p>
      </div>

      {/* Parking Protection — required Yes/No, gates Pay Now */}
      <ProtectionPlan
        value={protectionPlanChoice}
        onChange={onProtectionPlanChange}
        isUpdating={protectionPlanUpdating}
        // Lock during Stripe confirmPayment so the customer can't toggle
        // mid-charge (would 409 the update-pi endpoint).
        disabled={processing}
        toggleError={protectionToggleError}
      />

      {/* Stripe Payment Element */}
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <PaymentElement
          options={{
            layout: "tabs",
          }}
        />
      </div>

      {/* Terms & Conditions */}
      <div className="bg-gray-50 rounded-lg p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={acceptedTerms}
            onChange={(e) => onTermsChange(e.target.checked)}
            className="mt-1 w-5 h-5 text-brand-orange border-gray-300 rounded focus:ring-brand-orange cursor-pointer"
          />
          <span className="text-sm text-gray-600">
            I agree to the{" "}
            <a href="/terms" className="text-brand-orange hover:underline">
              Terms of Service
            </a>{" "}
            and{" "}
            <a href="/privacy" className="text-brand-orange hover:underline">
              Privacy Policy
            </a>
            . I understand that my reservation is subject to the parking
            facility's policies and that cancellations made within 24 hours of
            check-in may be subject to fees.
          </span>
        </label>
      </div>

      {/* Due at Location Notice */}
      {dueAtLocation && priceBreakdown.dueAtLocation > 0 && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <Wallet size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <span className="font-semibold text-amber-800">Pay at Location</span>
            <p className="text-amber-700 text-xs mt-0.5">
              ${priceBreakdown.dueAtLocation.toFixed(2)} will be collected on-site
              at check-in
            </p>
          </div>
        </div>
      )}

      {/* Error Messages */}
      {(paymentError || submitError) && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <span className="font-semibold text-red-800">Payment Error</span>
            <p className="text-red-700 text-xs mt-0.5">
              {paymentError || submitError}
            </p>
          </div>
        </div>
      )}

      {/* Security Notice */}
      <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
        <Lock size={14} />
        <span>Secured with 256-bit SSL encryption</span>
      </div>

      {/* Buttons */}
      <div className="flex gap-4">
        <button
          type="button"
          onClick={onBack}
          disabled={processing}
          className="flex items-center justify-center px-6 py-3 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <ChevronLeft size={18} className="mr-1" />
          Back
        </button>
        <button
          type="submit"
          disabled={processing || !acceptedTerms || !protectionAnswered || protectionPlanUpdating || protectionStateAmbiguous || !stripe || !elements}
          className="flex-1 bg-brand-orange text-white font-bold py-3.5 rounded-lg hover:bg-orange-600 transition-all shadow-md active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {processing ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              Processing...
            </>
          ) : protectionPlanUpdating ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              Updating total…
            </>
          ) : !protectionAnswered ? (
            <>Select a protection option above</>
          ) : protectionStateAmbiguous ? (
            // Server state is unknown after a network failure. The button
            // amount could be wrong; do not show a dollar value the
            // customer might trust.
            <>Toggle Yes/No again to confirm total</>
          ) : (
            <>
              <Check size={20} />
              {dueAtLocation && priceBreakdown.dueAtLocation > 0
                ? `Pay Now - $${buttonAmount.toFixed(2)}`
                : `Complete Booking - $${buttonAmount.toFixed(2)}`}
            </>
          )}
        </button>
      </div>
    </form>
  );
}
