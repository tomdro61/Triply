"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { PROTECTION_PLAN } from "@/lib/parkguard/client";

interface ProtectionPlanProps {
  isSelected: boolean;
  onToggle: (selected: boolean) => void;
  disabled?: boolean;
}

export function ProtectionPlan({
  isSelected,
  onToggle,
  disabled,
}: ProtectionPlanProps) {
  return (
    <div className="bg-amber-50/60 border border-amber-100 rounded-xl p-4">
      <div className="flex items-start gap-3 mb-2">
        <ShieldCheck size={22} className="text-emerald-600 flex-shrink-0 mt-0.5" />
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-gray-900">Parking Protection</span>
          <span className="bg-emerald-600 text-white text-[10px] uppercase tracking-wide font-bold px-2 py-0.5 rounded">
            Recommended
          </span>
        </div>
      </div>
      <p className="text-sm text-gray-600 ml-[34px] mb-3">
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
      <label className="ml-[34px] flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={disabled}
          className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 disabled:opacity-50"
        />
        <span className="text-sm text-gray-800">
          Yes, protect my vehicle for just{" "}
          <span className="font-semibold">${PROTECTION_PLAN.price.toFixed(2)}</span>
        </span>
      </label>
      {disabled && (
        <p className="text-xs text-gray-500 ml-[34px] mt-1">
          To change, go back to the previous step.
        </p>
      )}
    </div>
  );
}
