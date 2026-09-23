"use client";

import { Calendar as CalendarIcon } from "lucide-react";
import { format, parse } from "date-fns";
import { DateRangePicker } from "@/components/ui/date-picker";
import { maxAdvanceBookingDate } from "@/lib/booking-window";

interface DateRangeFieldProps {
  departDate: string;
  returnDate: string;
  onDepartChange: (value: string) => void;
  onReturnChange: (value: string) => void;
}

/**
 * The actual date-range picker (react-day-picker + Radix Popover). Split out
 * of SearchWidget so it can be `next/dynamic(..., { ssr: false })`-loaded —
 * this is the ~50 KB chunk we don't want in the initial /blog/[slug] bundle.
 * See date-range-field-skeleton.tsx for the static placeholder shown while it
 * loads — kept in its own file on purpose: anything this file imports rides
 * along in the lazy chunk, and anything that imports THIS file statically
 * would pull react-day-picker back into the initial bundle.
 */
export default function DateRangeField({
  departDate,
  returnDate,
  onDepartChange,
  onReturnChange,
}: DateRangeFieldProps) {
  return (
    <DateRangePicker
      startDate={departDate}
      endDate={returnDate}
      onStartChange={onDepartChange}
      onEndChange={onReturnChange}
      minDate={new Date()}
      maxDate={maxAdvanceBookingDate()}
    >
      {({ startTriggerProps, endTriggerProps }) => (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Depart</label>
            <button
              type="button"
              ref={startTriggerProps.ref}
              onClick={startTriggerProps.onClick}
              className="w-full flex items-center gap-2 px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-left hover:border-brand-orange transition-colors"
            >
              <CalendarIcon className="w-4 h-4 text-gray-400" />
              <span className={departDate ? "text-gray-900" : "text-gray-400"}>
                {departDate
                  ? format(parse(departDate, "yyyy-MM-dd", new Date()), "MMM d, yyyy")
                  : "Select date"}
              </span>
            </button>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Return</label>
            <button
              type="button"
              ref={endTriggerProps.ref}
              onClick={endTriggerProps.onClick}
              className="w-full flex items-center gap-2 px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-left hover:border-brand-orange transition-colors"
            >
              <CalendarIcon className="w-4 h-4 text-gray-400" />
              <span className={returnDate ? "text-gray-900" : "text-gray-400"}>
                {returnDate
                  ? format(parse(returnDate, "yyyy-MM-dd", new Date()), "MMM d, yyyy")
                  : "Select date"}
              </span>
            </button>
          </div>
        </>
      )}
    </DateRangePicker>
  );
}
