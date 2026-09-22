"use client";

import { Calendar as CalendarIcon } from "lucide-react";

/**
 * Static stand-in shown while the DateRangeField chunk loads. Same markup as
 * the real trigger buttons (minus the click handlers) so there's no layout
 * shift when the real thing mounts a moment later.
 *
 * Not `disabled` — a disabled control next to an enabled Search button reads
 * as broken, not loading. `cursor-wait` + `aria-busy` communicate "still
 * loading" without looking dead.
 */
export function DateRangeFieldSkeleton() {
  return (
    <>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Depart</label>
        <button
          type="button"
          aria-busy="true"
          aria-label="Depart date (loading)"
          className="w-full flex items-center gap-2 px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-left text-gray-400 cursor-wait"
        >
          <CalendarIcon className="w-4 h-4 text-gray-400" />
          <span>Select date</span>
        </button>
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Return</label>
        <button
          type="button"
          aria-busy="true"
          aria-label="Return date (loading)"
          className="w-full flex items-center gap-2 px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-left text-gray-400 cursor-wait"
        >
          <CalendarIcon className="w-4 h-4 text-gray-400" />
          <span>Select date</span>
        </button>
      </div>
    </>
  );
}
