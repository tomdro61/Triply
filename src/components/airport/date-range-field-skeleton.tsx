"use client";

import { Calendar as CalendarIcon } from "lucide-react";

/**
 * Static stand-in shown while the DateRangeField chunk loads. Same markup as
 * the real trigger buttons (minus the click handlers) so there's no layout
 * shift when the real thing mounts a moment later.
 */
export function DateRangeFieldSkeleton({
  departDate,
  returnDate,
}: { departDate: string; returnDate: string }) {
  return (
    <>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Depart</label>
        <button
          type="button"
          disabled
          className="w-full flex items-center gap-2 px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-left text-gray-400"
        >
          <CalendarIcon className="w-4 h-4 text-gray-400" />
          <span>{departDate || "Select date"}</span>
        </button>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Return</label>
        <button
          type="button"
          disabled
          className="w-full flex items-center gap-2 px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-left text-gray-400"
        >
          <CalendarIcon className="w-4 h-4 text-gray-400" />
          <span>{returnDate || "Select date"}</span>
        </button>
      </div>
    </>
  );
}
