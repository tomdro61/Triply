"use client";

import Link from "next/link";
import { useId } from "react";
import { ShieldCheck, Loader2, AlertCircle, CircleCheck } from "lucide-react";
import {
  PROTECTION_PLANS,
  PROTECTION_PLAN_CODES,
  formatLimit,
  type ProtectionChoice,
} from "@/lib/parkguard/plans";

interface ProtectionPlanProps {
  /** null = customer has not yet decided; a tier code or "none" = explicit choice */
  value: ProtectionChoice | null;
  onChange: (choice: ProtectionChoice) => void;
  /** True while the PaymentIntent is being updated server-side after a pick. */
  isUpdating?: boolean;
  /**
   * True when the parent is in a state where picks must be locked
   * (e.g., Stripe confirmPayment in flight). Disables the radios in
   * addition to whatever isUpdating already does.
   */
  disabled?: boolean;
  /**
   * Pick-specific error message (separate from payment / booking errors).
   * Rendered as an alert under the cards.
   */
  choiceError?: string | null;
}

interface PlanOption {
  choice: ProtectionChoice;
  title: string;
  price: number;
  /** Park-Guard-vetted wording — see the compliance note in src/lib/parkguard/plans.ts. */
  blurb: string;
  badge?: string;
  /** Border when this card is the selected one. */
  selectedBorder: string;
  radioClass: string;
  iconClass: string;
}

const TIER_STYLE = {
  selectedBorder: "border-emerald-600",
  radioClass: "text-emerald-600 focus:ring-emerald-500",
  iconClass: "text-emerald-600",
};

const OPTIONS: readonly PlanOption[] = [
  ...PROTECTION_PLAN_CODES.map((code): PlanOption => {
    const plan = PROTECTION_PLANS[code];
    return {
      choice: code,
      title: plan.label,
      price: plan.price,
      blurb: `Covers up to ${formatLimit(plan.limitDollars)} of theft and damages while parked at the lot.`,
      badge: code === "A" ? "Most Popular" : undefined,
      ...TIER_STYLE,
    };
  }),
  {
    choice: "none",
    title: "No protection",
    price: 0,
    blurb: "I agree to park at my own risk.",
    selectedBorder: "border-gray-500",
    radioClass: "text-gray-600 focus:ring-gray-500",
    iconClass: "text-gray-400",
  },
];

export function ProtectionPlan({
  value,
  onChange,
  isUpdating = false,
  disabled = false,
  choiceError = null,
}: ProtectionPlanProps) {
  // Unique radio-group name so multiple instances of this component on the
  // same page can't accidentally share native radio-group exclusivity.
  const groupName = useId();
  const fieldsetDisabled = isUpdating || disabled;

  return (
    <div className="bg-gradient-to-r from-emerald-50 to-amber-50 border border-emerald-100 rounded-xl p-5">
      <div className="flex items-start gap-3 mb-4">
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
            Protect your vehicle against theft and damages while you&apos;re away.
            Choose a plan below.
          </p>
        </div>
      </div>

      {/* Two-up from `sm`: the form column is ~700px wide on desktop, so four
          across would leave each card ~165px — too narrow for the blurb. */}
      <fieldset
        className="grid grid-cols-1 sm:grid-cols-2 gap-3"
        disabled={fieldsetDisabled}
        aria-busy={isUpdating}
      >
        <legend className="sr-only">Choose a Parking Protection plan for your booking</legend>
        {OPTIONS.map((option) => {
          const selected = value === option.choice;
          return (
            <label
              key={option.choice}
              className={`relative flex flex-col rounded-xl border-2 bg-white px-4 pt-4 pb-3 cursor-pointer select-none transition-colors ${
                selected ? option.selectedBorder : "border-gray-200 hover:border-emerald-300"
              } ${fieldsetDisabled ? "cursor-not-allowed opacity-70" : ""}`}
            >
              {option.badge && (
                <span className="absolute -top-2.5 left-3 bg-emerald-600 text-white text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded">
                  {option.badge}
                </span>
              )}
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-gray-900">{option.title}</span>
                <input
                  type="radio"
                  name={groupName}
                  value={option.choice}
                  checked={selected}
                  onChange={() => onChange(option.choice)}
                  className={`mt-0.5 w-4 h-4 flex-shrink-0 disabled:opacity-50 ${option.radioClass}`}
                />
              </div>
              <span className="text-xl font-bold text-gray-900 mt-1">
                ${option.price.toFixed(2)}
              </span>
              <span className="text-xs text-gray-500">per trip</span>
              <span className="mt-3 flex items-start gap-1.5 text-sm text-gray-700">
                <CircleCheck size={16} className={`flex-shrink-0 mt-0.5 ${option.iconClass}`} />
                <span>{option.blurb}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <p className="text-xs text-gray-600 mt-4">
        Travel with added peace of mind. Parking Protection helps with unexpected
        events during your stay, so you can leave your vehicle with more confidence.
        Plans are administered by Park Guard — see the{" "}
        <Link
          href="/terms#parking-protection"
          className="text-emerald-700 underline hover:no-underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          full terms
        </Link>{" "}
        for details.
      </p>

      {/* Pick-specific error — rendered under the cards so the customer
          associates it with their action. role=alert + aria-live so screen
          readers announce it. */}
      <div role="alert" aria-live="polite" className="mt-2 min-h-0">
        {choiceError && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{choiceError}</span>
          </div>
        )}
      </div>
    </div>
  );
}
