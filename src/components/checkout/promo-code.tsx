"use client";

import { useState } from "react";
import { Tag, X, Check, Loader2 } from "lucide-react";

export type ApplyPromoResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "network" };

interface PromoCodeProps {
  appliedCode: string | null;
  discount: number;
  onApply: (code: string) => Promise<ApplyPromoResult>;
  onRemove: () => void;
  /**
   * When true, both Apply and Remove are disabled (typically on the payment
   * step, when the Stripe PaymentIntent amount is already locked in).
   */
  locked?: boolean;
}

export function PromoCode({
  appliedCode,
  discount,
  onApply,
  onRemove,
  locked = false,
}: PromoCodeProps) {
  const [code, setCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApply = async () => {
    if (!code.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await onApply(code.trim().toUpperCase());
      if (result.ok) {
        setCode("");
      } else if (result.reason === "network") {
        setError("Couldn't reach the server — please try again");
      } else {
        setError("Invalid or expired promo code");
      }
    } catch {
      setError("Failed to apply promo code");
    } finally {
      setIsLoading(false);
    }
  };

  if (appliedCode) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
              <Check size={16} className="text-green-600" />
            </div>
            <div>
              <p className="font-medium text-green-800">{appliedCode}</p>
              <p className="text-sm text-green-600">
                ${discount.toFixed(2)} discount applied
              </p>
            </div>
          </div>
          {!locked && (
            <button
              onClick={onRemove}
              className="p-1 text-green-600 hover:text-green-800 transition-colors"
            >
              <X size={18} />
            </button>
          )}
        </div>
        {locked && (
          <p className="text-xs text-green-700 mt-2">
            Promo locked once payment is initialized. Click{" "}
            <span className="font-semibold">Back</span> to edit.
          </p>
        )}
      </div>
    );
  }

  if (locked) {
    return (
      <p className="text-xs text-gray-500 italic">
        Promo codes can&apos;t be added once payment is initialized. Click{" "}
        <span className="font-semibold not-italic">Back</span> to edit your booking.
      </p>
    );
  }

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Tag
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setError(null);
            }}
            className={`w-full pl-10 pr-4 py-2.5 border rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors text-sm ${
              error ? "border-red-500" : "border-gray-300"
            }`}
            placeholder="Enter promo code"
          />
        </div>
        <button
          type="button"
          onClick={handleApply}
          disabled={isLoading || !code.trim()}
          className="px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isLoading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            "Apply"
          )}
        </button>
      </div>
      {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
      <p className="text-gray-500 text-xs mt-1">
        Have a promo code? Enter it above.
      </p>
    </div>
  );
}
