"use client";

import { useEffect, useRef, useState } from "react";
import { Car } from "lucide-react";
import type { DirectCheckoutTerms } from "@/types/checkout";
import { atLotEstimate, formatCents, vehicleSizeOptions } from "@/lib/direct/vehicle-display";

/**
 * Vehicle size on the payment step of a DIRECT-lot checkout (vehicle-surcharge
 * plan §1.5, T6, R4, R8). Changing it never touches the PaymentIntent — the
 * surcharge is paid at the lot — so there is no async work here.
 *
 * - Collapsed ("Vehicle: Large SUV / truck · Change") when a choice exists;
 *   expanded with a prompt when none does (R8: Pay waits for a pick).
 * - Once opened it stays open until "Done": radios fire `change` on every arrow
 *   key, so collapsing on change would unmount the focused input and strand
 *   keyboard users. Focus moves to the checked radio on open and back to
 *   "Change" on close.
 * - `disabled` while a payment is in flight (R4), like Parking Protection.
 * - The amounts are display estimates from the checkout's own terms; the server
 *   computes what is stored from the PaymentIntent.
 */
export function VehicleSizeSelector({
  terms,
  value,
  onChange,
  disabled,
}: {
  terms: DirectCheckoutTerms;
  value: string | null;
  onChange: (code: string) => void;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(value === null);
  const options = vehicleSizeOptions(terms.vehicleSurcharges);
  const chosen = options.find((o) => o.code === value) ?? null;
  const open = expanded || chosen === null;

  // Where focus goes after the customer opens or closes the list (never on mount).
  const focusAfterToggle = useRef<"radio" | "change" | null>(null);
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const target = focusAfterToggle.current;
    focusAfterToggle.current = null;
    if (target === "radio") {
      const radios = fieldsetRef.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
      const checked = Array.from(radios ?? []).find((r) => r.checked);
      (checked ?? radios?.[0])?.focus();
    } else if (target === "change") {
      changeRef.current?.focus();
    }
  }, [open]);

  const lineFor = (dailyRateCents: number, code: string) => {
    if (dailyRateCents === 0) return "No extra charge";
    const e = atLotEstimate(options.find((o) => o.code === code)!, terms.days, terms.taxRatePercent);
    return `+${formatCents(dailyRateCents)}/day — about ${formatCents(e.atLotCents)} at the lot`;
  };

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 font-semibold text-gray-900">
          <Car size={18} className="text-brand-orange" aria-hidden />
          Vehicle size
        </h3>
        {!open ? (
          <button
            ref={changeRef}
            type="button"
            onClick={() => {
              focusAfterToggle.current = "radio";
              setExpanded(true);
            }}
            disabled={disabled}
            aria-expanded={false}
            aria-label="Change vehicle size"
            className="text-sm font-medium text-brand-orange hover:underline disabled:opacity-50"
          >
            Change
          </button>
        ) : (
          chosen !== null && (
            <button
              type="button"
              onClick={() => {
                focusAfterToggle.current = "change";
                setExpanded(false);
              }}
              disabled={disabled}
              aria-expanded={true}
              className="text-sm font-medium text-brand-orange hover:underline disabled:opacity-50"
            >
              Done
            </button>
          )
        )}
      </div>

      {!open && chosen ? (
        <p className="mt-1 text-sm text-gray-700">
          {chosen.label}
          {chosen.dailyRateCents > 0 && <span className="text-gray-500"> · {lineFor(chosen.dailyRateCents, chosen.code)}</span>}
        </p>
      ) : (
        <fieldset ref={fieldsetRef} className="mt-2" disabled={disabled}>
          <legend className={`text-sm mb-2 ${chosen === null ? "text-amber-700 font-medium" : "text-gray-600"}`}>
            {chosen === null
              ? "Choose your vehicle size — this lot charges extra for larger vehicles, paid at the lot."
              : "Larger vehicles pay a surcharge at the lot, not online."}
          </legend>
          <div className="space-y-2">
            {options.map((o) => (
              <label
                key={o.code}
                className={`flex items-center justify-between gap-3 rounded-lg border p-3 cursor-pointer ${
                  o.code === value ? "border-brand-orange bg-orange-50" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="checkout-vehicle-size"
                    value={o.code}
                    checked={o.code === value}
                    onChange={() => onChange(o.code)}
                    className="w-4 h-4 accent-[#f87356]"
                  />
                  <span className="text-sm font-medium text-gray-900">{o.label}</span>
                </span>
                <span className="text-xs text-gray-600 text-right">{lineFor(o.dailyRateCents, o.code)}</span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">
            The lot checks your vehicle at drop-off. If it&apos;s a different size, they&apos;ll charge their posted rate.
          </p>
        </fieldset>
      )}
    </div>
  );
}
