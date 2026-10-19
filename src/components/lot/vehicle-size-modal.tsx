"use client";

import { useEffect, useMemo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X, Car } from "lucide-react";
import { NO_OVERSIZED_VEHICLE } from "@/lib/direct/vehicle-size";
import { PROTECTION_PLANS } from "@/lib/parkguard/plans";
import {
  atLotEstimate,
  directReserveQuote,
  formatCents,
  vehicleSizeOptions,
} from "@/lib/direct/vehicle-display";

/**
 * "Is your vehicle oversized?" — opened by Reserve on a direct lot that has
 * vehicle surcharges, BEFORE checkout (vehicle-surcharge plan §1.4, T4/T5).
 *
 * - "No oversized vehicle" is pre-selected every time it opens (T5).
 * - Totals come from the dates and times CURRENTLY on screen (R6), through the
 *   same pure functions checkout uses. The surcharge is paid AT THE LOT and is
 *   never part of "charged online".
 * - No network calls. Continue hands the code to the caller, which re-checks
 *   the check-in time is still bookable and navigates (R6/§1.4).
 * - Portalled to <body> above the mobile Reserve footer (z 9998) and the search
 *   slider (z 60) — R13. Radix supplies focus trap, Escape and aria.
 */
export interface VehicleSizeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  surcharges: readonly { code: string; label: string; dailyRateCents: number }[];
  rateCents: number;
  taxRatePercent: number;
  checkIn: string;
  checkInTime: string;
  checkOut: string;
  checkOutTime: string;
  onContinue: (vehicleSize: string) => void;
}

export function VehicleSizeModal({
  open,
  onOpenChange,
  surcharges,
  rateCents,
  taxRatePercent,
  checkIn,
  checkInTime,
  checkOut,
  checkOutTime,
  onContinue,
}: VehicleSizeModalProps) {
  const [selected, setSelected] = useState<string>(NO_OVERSIZED_VEHICLE);
  const [navigating, setNavigating] = useState(false);

  // Fresh each time it opens: "No oversized vehicle" pre-selected (T5), and a
  // Continue the caller refused (a slot that just passed) does not stay locked.
  useEffect(() => {
    if (open) {
      setSelected(NO_OVERSIZED_VEHICLE);
      setNavigating(false);
    }
  }, [open]);

  const options = useMemo(() => vehicleSizeOptions(surcharges), [surcharges]);
  const quote = directReserveQuote({ rateCents, taxRatePercent, checkIn, checkInTime, checkOut, checkOutTime });
  const chosen = options.find((o) => o.code === selected) ?? options[0];
  const estimate = quote ? atLotEstimate(chosen, quote.days, taxRatePercent) : null;

  const handleContinue = () => {
    if (navigating) return;
    setNavigating(true);
    onContinue(chosen.code);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !navigating && onOpenChange(next)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[10000] bg-black/50" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-[10001] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white shadow-xl outline-none max-h-[calc(100dvh-2rem)] overflow-y-auto"
        >
          <div className="flex items-start justify-between gap-4 p-5 pb-3">
            <div>
              <DialogPrimitive.Title className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <Car size={20} className="text-brand-orange" aria-hidden />
                Is your vehicle oversized?
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-sm text-gray-600 mt-1">
                This lot charges extra for larger vehicles. The surcharge is paid at the lot, not online.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-50"
              disabled={navigating}
              aria-label="Close"
            >
              <X size={20} />
            </DialogPrimitive.Close>
          </div>

          <fieldset className="px-5">
            <legend className="sr-only">Vehicle size</legend>
            <div className="space-y-2">
              {options.map((o) => {
                const checked = o.code === selected;
                return (
                  <label
                    key={o.code}
                    className={`flex items-center justify-between gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                      checked ? "border-brand-orange bg-orange-50" : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <input
                        type="radio"
                        name="vehicle-size"
                        value={o.code}
                        checked={checked}
                        onChange={() => setSelected(o.code)}
                        disabled={navigating}
                        className="w-4 h-4 accent-[#f87356]"
                      />
                      <span className="text-sm font-medium text-gray-900">{o.label}</span>
                    </span>
                    <span className="text-sm text-gray-600 text-right">
                      {o.dailyRateCents === 0 ? "No extra charge" : `+${formatCents(o.dailyRateCents)}/day, paid at the lot`}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="mx-5 mt-4 rounded-lg bg-gray-50 p-4 text-sm space-y-2">
            {quote && estimate ? (
              <>
                <div className="flex justify-between gap-4">
                  <span className="text-gray-700">Charged online today</span>
                  <span className="font-semibold text-gray-900">{formatCents(quote.onlineCents)}</span>
                </div>
                <p className="text-xs text-gray-500 -mt-1">
                  Parking, tax and service fee for {quote.days} day{quote.days === 1 ? "" : "s"}. Plus Parking Protection if you
                  keep it — {PROTECTION_PLANS.A.label} ({formatCents(Math.round(PROTECTION_PLANS.A.price * 100))}) is
                  pre-selected at checkout and you can remove it.
                </p>
                {estimate.atLotCents > 0 && (
                  <>
                    <div className="flex justify-between gap-4">
                      <span className="text-gray-700">Estimated due at the lot</span>
                      <span className="font-semibold text-gray-900">{formatCents(estimate.atLotCents)}</span>
                    </div>
                    <p className="text-xs text-gray-500 -mt-1">
                      {formatCents(estimate.surchargeCents)} surcharge + {formatCents(estimate.surchargeTaxCents)} tax
                    </p>
                    <div className="flex justify-between gap-4 border-t border-gray-200 pt-2">
                      <span className="text-gray-700">Estimated trip total (before Parking Protection)</span>
                      <span className="font-bold text-gray-900">{formatCents(quote.onlineCents + estimate.atLotCents)}</span>
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="text-gray-600">Your total is shown at checkout.</p>
            )}
          </div>

          <p className="px-5 mt-3 text-xs text-gray-500">
            The lot checks your vehicle at drop-off. If it&apos;s a different size, they&apos;ll charge their posted rate.
            You can change this at checkout.
          </p>

          <div className="p-5 pt-4">
            <button
              type="button"
              onClick={handleContinue}
              disabled={navigating}
              className="w-full bg-brand-orange text-white font-bold py-3 rounded-lg shadow-md hover:bg-orange-600 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              {navigating ? "Loading checkout…" : "Continue to checkout"}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
