"use client";

/**
 * The /park-stay search header (CX plan v2 §3, with Tom's 20 Oct change to
 * "Hotel check-in date" + "Parking return date"), in the parking
 * SearchHeader's look (§12.2: its container, field boxes, brand-blue
 * calendar icons, orange "Update" button and mobile summary bar — classes
 * copied; SearchHeader itself is a customer component and is not reused).
 *
 * - The shared DateRangePicker's start is the HOTEL CHECK-IN date (the
 *   `night` URL key, as is) and its end the PARKING RETURN date.
 * - Check-in from today at the AIRPORT; return on or after the hotel
 *   check-out day and within 60 days of the check-in — the server's own
 *   rules (validateParkStayWindow). The calendar footer states those limits
 *   (`windowNote`), not parking's 100-day sentence.
 * - The picker's swap of a return picked before the check-in is REJECTED,
 *   not applied (isPickerSwap).
 * - Arrive at the hotel, return time and guests arrive already filled in:
 *   the URL's value, or the starting value from withSearchDefaults() (Tom,
 *   21 Oct 2026), so a search shows results at once. The missing-highlight
 *   and prompt remain only as a fallback.
 * - Every submit keeps `focus`.
 * - The mode switch (§12.1) sits on its own line above the fields on
 *   desktop (the parking SearchHeader places it the same way, so switching
 *   pages doesn't move it), and directly above the mobile summary bar — OUTSIDE its button
 *   (a link inside a button is invalid). The fields are always two rows on
 *   desktop, so nothing is squeezed or clipped.
 *
 * The parent re-keys this on the URL, so its state always starts from what
 * was searched.
 */

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Calendar as CalendarIcon, ChevronDown, ChevronUp, MapPin, SlidersHorizontal } from "lucide-react";
import { DateRangePicker } from "@/components/ui/date-picker";
import { ARRIVAL_TIME_OPTIONS, RETURN_TIME_OPTIONS, formatNightLabel } from "./format";
import { ParkStayAirportSelect } from "./airport-select";
import { SearchModeSwitch, type ModeSide } from "./search-mode-switch";
import {
  ADULT_OPTIONS,
  PARK_STAY_WINDOW_NOTE,
  RETURN_BEFORE_CHECKIN,
  detailsPrompt,
  isPickerSwap,
  missingDetails,
  parkStayDateBounds,
  pickerDate,
  pickerMaxDate,
  submitHref,
  type DatesProblem,
  type ParkStayAirportOption,
  type ParkStaySearchValues,
  airportTimeZone,
} from "./search-values";

/** SearchHeader's field box, and its "missing" twin (highlighted, never filled in). */
const BOX_OK = "py-2.5 px-3 bg-gray-50 border border-gray-200 rounded-lg";
const BOX_MISSING = "py-2.5 px-3 bg-amber-50 border border-amber-400 ring-2 ring-amber-200 rounded-lg";

function DetailSelect({
  prefix,
  ariaLabel,
  placeholder,
  value,
  options,
  missing,
  onChange,
}: {
  prefix: string;
  ariaLabel: string;
  placeholder: string;
  value: string;
  options: readonly string[];
  missing: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className={`flex min-w-0 items-center ${missing ? BOX_MISSING : BOX_OK}`}>
      <span className="mr-1.5 whitespace-nowrap text-sm text-gray-500" aria-hidden="true">
        {prefix}
      </span>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={missing || undefined}
        className={`w-full min-w-0 cursor-pointer bg-transparent text-sm outline-none ${value ? "font-medium text-gray-900" : "text-gray-400"}`}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((o) => (
          <option key={o} value={o} className="text-gray-900">
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ParkStayHeader({
  airports,
  values,
  focus,
  parking,
  currentHref,
}: {
  airports: ParkStayAirportOption[];
  /** What the URL searched, SANITISED (sanitizeSearchValues; "" = missing). */
  values: ParkStaySearchValues;
  focus: string | null;
  /** The switch's "Parking only" side: its link, or why there is none. */
  parking: ModeSide;
  currentHref: string;
}) {
  const router = useRouter();
  const [airport, setAirport] = useState(values.airport);
  const [night, setNight] = useState(values.night);
  const [returnDate, setReturnDate] = useState(values.returnDate);
  const [arrivalTime, setArrivalTime] = useState(values.arrivalTime);
  const [returnTime, setReturnTime] = useState(values.returnTime);
  const [adults, setAdults] = useState(values.adults);
  // The start the picker sent in THIS click (see isPickerSwap); cleared by the end that follows.
  const pendingStart = useRef<{ start: string; prevStart: string } | null>(null);
  const [problem, setProblem] = useState<DatesProblem | null>(null);
  const missing = missingDetails({ arrivalTime, returnTime, adults });
  // Mobile: open when something is still to fill in, collapsed once searched.
  const [expanded, setExpanded] = useState(!(airport && night && returnDate) || missing.length > 0);

  const timeZone = airportTimeZone(airports, airport);
  // "Today" at the airport, read on every render so a page left open past
  // midnight doesn't keep offering yesterday (review recheck L4). Only the
  // picker's limits — never a default for any booking value.
  const bounds = parkStayDateBounds(timeZone, new Date());
  const maxPick = pickerMaxDate({ night, returnDate }, bounds);
  const prompt = detailsPrompt(missing);

  function onCheckinChange(v: string) {
    pendingStart.current = { start: v, prevStart: night };
    setNight(v);
    setProblem(null);
  }

  function onReturnChange(v: string) {
    const pending = pendingStart.current;
    pendingStart.current = null;
    if (pending && isPickerSwap(pending, v)) {
      // The picker swapped a return picked before the check-in: keep the
      // check-in and the return as they were, and say why.
      setNight(pending.prevStart);
      setProblem({ field: "return", message: RETURN_BEFORE_CHECKIN });
      return;
    }
    setReturnDate(v);
    setProblem(null);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const out = submitHref({ airport, night, arrivalTime, returnDate, returnTime, adults }, bounds, focus);
    if (!out.ok) {
      setProblem(out.problem);
      return;
    }
    setProblem(null);
    router.push(out.href);
    if (missing.length === 0) setExpanded(false);
  }

  const summaryDates = night ? `${formatNightLabel(night)} — ${returnDate ? formatNightLabel(returnDate) : "Return"}` : "Add your dates";
  const modeSwitch = <SearchModeSwitch mode="park-stay" parking={parking} parkStay={{ href: currentHref }} />;

  return (
    <div className="bg-white border-b border-gray-200 z-30 shadow-sm relative flex-shrink-0">
      {/* Mobile: the switch, then the compact summary bar. Only the summary is inside the button. */}
      <div className="lg:hidden">
        <div className="px-4 pt-3">{modeSwitch}</div>
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          aria-controls="park-stay-search-form"
          className="w-full px-4 py-3 flex items-center justify-between"
        >
          <span className="flex items-center gap-3 min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
              <MapPin size={16} className="text-brand-orange flex-shrink-0" aria-hidden="true" />
              {airport || "Airport"}
            </span>
            <span className="text-gray-300" aria-hidden="true">
              |
            </span>
            <span className="flex items-center gap-1.5 text-sm text-gray-600 truncate">
              <CalendarIcon size={14} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{summaryDates}</span>
            </span>
          </span>
          <span className="flex items-center gap-1 ml-3 flex-shrink-0 text-brand-orange" aria-hidden="true">
            <SlidersHorizontal size={16} />
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </button>
      </div>

      <form
        id="park-stay-search-form"
        onSubmit={submit}
        noValidate
        className={`${expanded ? "block" : "hidden"} lg:block px-4 pb-4 pt-3 border-t border-gray-100 lg:border-t-0 lg:max-w-7xl lg:mx-auto lg:px-8 lg:pt-2`}
      >
        {/* Desktop: the switch on its own line above the fields. */}
        <div className="hidden lg:block mb-3">{modeSwitch}</div>
        {/* Always two rows — airport + dates, then the three details + Update.
            All seven on one row don't fit the 1280 px content width: the date
            boxes were squeezed under the time fields. */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row gap-3 min-w-0">
            <div className="sm:w-56 flex-shrink-0">
              <ParkStayAirportSelect
                value={airport}
                onChange={(code) => {
                  setAirport(code);
                  setProblem(null);
                }}
                airports={airports}
                variant="compact"
                invalid={problem?.field === "airport"}
                label="Airport"
              />
            </div>

            <DateRangePicker
              startDate={night}
              endDate={returnDate}
              onStartChange={onCheckinChange}
              onEndChange={onReturnChange}
              minDate={pickerDate(bounds.today)}
              maxDate={pickerDate(maxPick)}
              windowNote={PARK_STAY_WINDOW_NOTE}
            >
              {({ startTriggerProps, endTriggerProps }) => (
                <div className="flex flex-col sm:flex-row gap-3 flex-1 min-w-0">
                  <div className={`flex-1 ${BOX_OK}`}>
                    <button
                      type="button"
                      ref={startTriggerProps.ref}
                      onClick={startTriggerProps.onClick}
                      aria-label={night ? `Hotel check-in date, ${formatNightLabel(night)}` : "Hotel check-in date"}
                      aria-invalid={problem?.field === "night" || undefined}
                      className="flex items-center w-full text-left cursor-pointer text-sm"
                    >
                      <CalendarIcon size={20} className="mr-2 text-brand-blue opacity-80 flex-shrink-0" aria-hidden="true" />
                      <span className="mr-1 whitespace-nowrap text-gray-500">Hotel check-in</span>
                      <span className={night ? "text-gray-900 font-medium truncate" : "text-gray-400 truncate"}>{night ? formatNightLabel(night) : "Choose"}</span>
                    </button>
                  </div>
                  <div className={`flex-1 ${BOX_OK}`}>
                    <button
                      type="button"
                      ref={endTriggerProps.ref}
                      onClick={endTriggerProps.onClick}
                      aria-label={returnDate ? `Parking return date, ${formatNightLabel(returnDate)}` : "Parking return date"}
                      aria-invalid={problem?.field === "return" || undefined}
                      className="flex items-center w-full text-left cursor-pointer text-sm"
                    >
                      <CalendarIcon size={20} className="mr-2 text-brand-blue opacity-80 flex-shrink-0" aria-hidden="true" />
                      <span className="mr-1 whitespace-nowrap text-gray-500">Parking return</span>
                      <span className={returnDate ? "text-gray-900 font-medium truncate" : "text-gray-400 truncate"}>{returnDate ? formatNightLabel(returnDate) : "Choose"}</span>
                    </button>
                  </div>
                </div>
              )}
            </DateRangePicker>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 flex-1">
              <DetailSelect
                prefix="At hotel"
                ariaLabel="Arrive at the hotel"
                placeholder="Time"
                value={arrivalTime}
                options={ARRIVAL_TIME_OPTIONS}
                missing={arrivalTime.length === 0}
                onChange={setArrivalTime}
              />
              <DetailSelect
                prefix="Back"
                ariaLabel="Return time"
                placeholder="Time"
                value={returnTime}
                options={RETURN_TIME_OPTIONS}
                missing={returnTime.length === 0}
                onChange={setReturnTime}
              />
              <DetailSelect prefix="Guests" ariaLabel="Guests" placeholder="Adults" value={adults} options={ADULT_OPTIONS} missing={adults.length === 0} onChange={setAdults} />
            </div>

            <button
              type="submit"
              className="bg-brand-orange hover:bg-orange-600 text-white font-bold py-2.5 px-6 rounded-lg shadow-sm transition-all active:scale-95 whitespace-nowrap"
            >
              <span className="lg:hidden">Update Search</span>
              <span className="hidden lg:inline">Update</span>
            </button>
          </div>
        </div>

        <div className="mt-2 space-y-1 text-sm">
          {problem && (
            <p role="alert" className="text-sm font-medium text-red-600">
              {problem.message}
            </p>
          )}
          {prompt && (
            <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {prompt}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
