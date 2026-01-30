"use client";

import { useState } from "react";
import {
  CreditCard,
  Lock,
  ChevronLeft,
  Loader2,
  Check,
  Smartphone,
} from "lucide-react";
import { PriceBreakdown } from "@/types/checkout";

interface PaymentStepProps {
  priceBreakdown: PriceBreakdown;
  acceptedTerms: boolean;
  onTermsChange: (accepted: boolean) => void;
  onBack: () => void;
  onSubmit: () => Promise<void>;
}

export function PaymentStep({
  priceBreakdown,
  acceptedTerms,
  onTermsChange,
  onBack,
  onSubmit,
}: PaymentStepProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [nameOnCard, setNameOnCard] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"card" | "apple" | "google">("card");

  const formatCardNumber = (value: string) => {
    const v = value.replace(/\s+/g, "").replace(/[^0-9]/gi, "");
    const matches = v.match(/\d{4,16}/g);
    const match = (matches && matches[0]) || "";
    const parts = [];
    for (let i = 0, len = match.length; i < len; i += 4) {
      parts.push(match.substring(i, i + 4));
    }
    return parts.length ? parts.join(" ") : value;
  };

  const formatExpiry = (value: string) => {
    const v = value.replace(/\s+/g, "").replace(/[^0-9]/gi, "");
    if (v.length >= 2) {
      return v.substring(0, 2) + "/" + v.substring(2, 4);
    }
    return v;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acceptedTerms) return;

    setIsProcessing(true);
    try {
      // Simulate payment processing
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await onSubmit();
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900 mb-1">Payment</h2>
        <p className="text-gray-500 text-sm">
          Your payment information is secure and encrypted
        </p>
      </div>

      {/* Payment Method Tabs */}
      <div className="flex gap-2 p-1 bg-gray-100 rounded-lg">
        <button
          type="button"
          onClick={() => setPaymentMethod("card")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-colors ${
            paymentMethod === "card"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          <CreditCard size={18} />
          Card
        </button>
        <button
          type="button"
          onClick={() => setPaymentMethod("apple")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-colors ${
            paymentMethod === "apple"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          <Smartphone size={18} />
          Apple Pay
        </button>
        <button
          type="button"
          onClick={() => setPaymentMethod("google")}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-colors ${
            paymentMethod === "google"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-600 hover:text-gray-900"
          }`}
        >
          <Smartphone size={18} />
          Google Pay
        </button>
      </div>

      {paymentMethod === "card" ? (
        <div className="space-y-4">
          {/* Card Number */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Card Number
            </label>
            <div className="relative">
              <CreditCard
                size={18}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <input
                type="text"
                value={cardNumber}
                onChange={(e) => setCardNumber(formatCardNumber(e.target.value))}
                maxLength={19}
                className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors"
                placeholder="4242 4242 4242 4242"
                required
              />
              <Lock
                size={16}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Test card: 4242 4242 4242 4242
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Expiry */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Expiry Date
              </label>
              <input
                type="text"
                value={expiry}
                onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                maxLength={5}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors"
                placeholder="MM/YY"
                required
              />
            </div>

            {/* CVC */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                CVC
              </label>
              <input
                type="text"
                value={cvc}
                onChange={(e) =>
                  setCvc(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))
                }
                maxLength={4}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors"
                placeholder="123"
                required
              />
            </div>
          </div>

          {/* Name on Card */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name on Card
            </label>
            <input
              type="text"
              value={nameOnCard}
              onChange={(e) => setNameOnCard(e.target.value)}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors"
              placeholder="John Doe"
              required
            />
          </div>
        </div>
      ) : (
        <div className="bg-gray-50 rounded-lg p-8 text-center">
          <Smartphone size={48} className="mx-auto text-gray-400 mb-4" />
          <p className="text-gray-600 font-medium">
            {paymentMethod === "apple" ? "Apple Pay" : "Google Pay"} will open when you click "Complete Booking"
          </p>
          <p className="text-gray-500 text-sm mt-2">
            (Demo mode - payment will be simulated)
          </p>
        </div>
      )}

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
          disabled={isProcessing}
          className="flex items-center justify-center px-6 py-3 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <ChevronLeft size={18} className="mr-1" />
          Back
        </button>
        <button
          type="submit"
          disabled={isProcessing || !acceptedTerms}
          className="flex-1 bg-brand-orange text-white font-bold py-3.5 rounded-lg hover:bg-orange-600 transition-all shadow-md active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isProcessing ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Check size={20} />
              Complete Booking - ${priceBreakdown.total.toFixed(2)}
            </>
          )}
        </button>
      </div>
    </form>
  );
}
