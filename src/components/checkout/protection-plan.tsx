"use client";

import Link from "next/link";
import { useId } from "react";
import { ShieldCheck, Loader2, AlertCircle } from "lucide-react";
import { PROTECTION_PLAN } from "@/lib/parkguard/client";

interface ProtectionPlanProps {
  /** null = customer has not yet decided; true/false = explicit choice */
  value: boolean | null;
  onChange: (selected: boolean) => void;
  /** True while the PaymentIntent is being updated server-side after a toggle. */
  isUpdating?: boolean;
  /**
   * True when the parent is in a state where toggles must be locked
   * (e.g., Stripe confirmPayment in flight). Disables the radios in
   * addition to whatever isUpdating already does.
   */
  disabled?: boolean;
  /**
   * Toggle-specific error message (separate from payment / booking errors).
   * Rendered as an alert under the radios.
   */
  toggleError?: string | null;
}

export function ProtectionPlan({
  value,
  onChange,
  isUpdating = false,
  disabled = false,
  toggleError = null,
}: ProtectionPlanProps) {
  // Unique radio-group name so multiple instances of this component on the
  // same page can't accidentally share native radio-group exclusivity.
  const groupName = useId();
  const fieldsetDisabled = isUpdating || disabled;

  return (
    <div className="bg-gradient-to-r from-emerald-50 to-amber-50 border border-emerald-100 rounded-xl p-5">
      <div className="flex items-start gap-3 mb-3">
        <ShieldCheck size={22} className="text-emerald-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-gray-900">Parking Protection</span>
            <span className="bg-emerald-600 text-white text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded">
              Recommended
            </span>
            {isUpdating && (
              <span className="flex items-center gap-1 text-xs text-emerald-700">
                <Loader2 size={14} className="animate-spin" />
                Updating total…
              </span>
            )}
          </div>
          <p className="text-sm text-gray-700 mt-1">
            Covers ${PROTECTION_PLAN.limitDollars.toLocaleString()} in damages and theft while parked.{" "}
            <Link
              href="/terms#parking-protection"
              className="text-emerald-700 underline hover:no-underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              See full terms
            </Link>
          </p>
        </div>
      </div>

      <fieldset
        className="space-y-2 ml-9"
        disabled={fieldsetDisabled}
        aria-busy={isUpdating}
      >
        <legend className="sr-only">Add Parking Protection to your booking</legend>
        <label
          className={`flex items-center gap-2 cursor-pointer select-none rounded-lg border px-3 py-2 transition-colors ${
            value === true
              ? "border-emerald-600 bg-white"
              : "border-transparent hover:bg-white/60"
          } ${fieldsetDisabled ? "cursor-not-allowed opacity-70" : ""}`}
        >
          <input
            type="radio"
            name={groupName}
            checked={value === true}
            onChange={() => onChange(true)}
            className="w-4 h-4 text-emerald-600 focus:ring-emerald-500 disabled:opacity-50"
          />
          <span className="text-sm text-gray-800">
            Yes, protect my vehicle for{" "}
            <span className="font-semibold">${PROTECTION_PLAN.price.toFixed(2)}</span>
          </span>
        </label>
        <label
          className={`flex items-center gap-2 cursor-pointer select-none rounded-lg border px-3 py-2 transition-colors ${
            value === false
              ? "border-gray-400 bg-white"
              : "border-transparent hover:bg-white/60"
          } ${fieldsetDisabled ? "cursor-not-allowed opacity-70" : ""}`}
        >
          <input
            type="radio"
            name={groupName}
            checked={value === false}
            onChange={() => onChange(false)}
            className="w-4 h-4 text-gray-600 focus:ring-gray-500 disabled:opacity-50"
          />
          <span className="text-sm text-gray-700">
            No, I&apos;ll park at my own risk
          </span>
        </label>
      </fieldset>

      {/* Toggle-specific error — rendered under the radios so the customer
          associates it with their toggle action. role=alert + aria-live so
          screen readers announce it. */}
      <div role="alert" aria-live="polite" className="ml-9 mt-2 min-h-0">
        {toggleError && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{toggleError}</span>
          </div>
        )}
      </div>
    </div>
  );
}
