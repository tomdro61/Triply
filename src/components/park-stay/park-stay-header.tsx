"use client";

/**
 * The /park-stay search header (CX plan v2 §3, with Tom's 20 Oct change to
 * "Hotel check-in date" + "Parking return date"), replacing the native form.
 *
 * - The shared DateRangePicker's start is the HOTEL CHECK-IN date (the
 *   `night` URL key, as is) and its end the PARKING RETURN date.
 * - Check-in from today at the AIRPORT; return on or after the hotel
 *   check-out day and within 60 days of the check-in — the server's own
 *   rules (validateParkStayWindow).
 * - The picker's swap of a return picked before the check-in is REJECTED,
 *   not applied (isPickerSwap).
 * - Arrive at the hotel, return time and guests start EMPTY unless the URL
 *   has them — no defaults; a missing one is highlighted with the prompt,
 *   and the results stay idle (no fetch) until all are set.
 * - Every submit keeps `focus`.
 * - Mobile: a collapsed summary bar (a button) over an expandable form; the
 *   mode toggle sits OUTSIDE that button (a link inside a button is invalid).
 *
 * The parent re-keys this on the URL, so its state always starts from what
 * was searched.
 */

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Calendar as CalendarIcon, ChevronDown, ChevronUp, MapPin, SlidersHorizontal } from "lucide-react";
import { DateRangePicker } from "@/components/ui/date-picker";
import { ARRIVAL_TIME_OPTIONS, RETURN_TIME_OPTIONS, formatNightLabel } from "./format";
import { ParkStayModeToggle } from "./mode-toggle";
import {
  ADULT_OPTIONS,
  RETURN_BEFORE_CHECKIN,
  detailsPrompt,
  isPickerSwap,
  missingDetails,
  parkStayDateBounds,
  pickerMaxDate,
  submitHref,
  type DatesProblem,
  type ParkStayAirportOption,
  type ParkStaySearchValues,
  airportTimeZone,
} from "./search-values";

/** A LOCAL-midnight Date for the picker, built from the literal calendar date (the picker compares local days). */
function pickerDate(iso: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

const fieldBase = "w-full rounded-lg border px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-orange/40";
const fieldOk = "border-gray-200 bg-gray-50";
const fieldMissing = "border-amber-400 bg-amber-50 ring-2 ring-amber-200";

function DetailSelect({
  label,
  placeholder,
  value,
  options,
  missing,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  options: readonly string[];
  missing: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block lg:w-36">
      <span className="mb-1 block text-[11px] font-medium text-gray-500">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={missing || undefined} className={`${fieldBase} ${missing ? fieldMissing : fieldOk}`}>
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ParkStayHeader({
  airports,
  values,
  focus,
  parkingHref,
  currentHref,
}: {
  airports: ParkStayAirportOption[];
  /** What the URL searched, SANITISED (sanitizeSearchValues; "" = missing). */
  values: ParkStaySearchValues;
  focus: string | null;
  parkingHref: string | null;
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

  return (
    <div className="relative z-30 flex-shrink-0 border-b border-gray-200 bg-white shadow-sm">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 pt-2 sm:px-6 lg:px-8">
        <ParkStayModeToggle parkingHref={parkingHref} currentHref={currentHref} />
      </div>

      {/* Mobile: compact summary bar. Only the summary is inside the button. */}
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        aria-expanded={expanded}
        aria-controls="park-stay-search-form"
        className="flex w-full items-center justify-between px-4 py-3 lg:hidden"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
            <MapPin size={16} className="flex-shrink-0 text-brand-orange" aria-hidden="true" />
            {airport || "Airport"}
          </span>
          <span className="text-gray-300" aria-hidden="true">
            |
          </span>
          <span className="flex items-center gap-1.5 truncate text-sm text-gray-600">
            <CalendarIcon size={14} className="flex-shrink-0 text-gray-400" aria-hidden="true" />
            <span className="truncate">{summaryDates}</span>
          </span>
        </span>
        <span className="ml-3 flex flex-shrink-0 items-center gap-1 text-brand-orange" aria-hidden="true">
          <SlidersHorizontal size={16} />
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>

      <form
        id="park-stay-search-form"
        onSubmit={submit}
        noValidate
        className={`${expanded ? "block" : "hidden"} mx-auto max-w-7xl border-t border-gray-100 px-4 pb-4 pt-3 sm:px-6 lg:block lg:border-t-0 lg:px-8 lg:pt-2`}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <label className="block lg:w-40">
            <span className="mb-1 block text-[11px] font-medium text-gray-500">Airport</span>
            <select
              value={airport}
              onChange={(e) => {
                setAirport(e.target.value);
                setProblem(null);
              }}
              aria-invalid={problem?.field === "airport" || undefined}
              className={`${fieldBase} ${fieldOk}`}
            >
              <option value="" disabled>
                Choose
              </option>
              {airports.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} — {a.name}
                </option>
              ))}
            </select>
          </label>

          <DateRangePicker
            startDate={night}
            endDate={returnDate}
            onStartChange={onCheckinChange}
            onEndChange={onReturnChange}
            minDate={pickerDate(bounds.today)}
            maxDate={pickerDate(maxPick)}
          >
            {({ startTriggerProps, endTriggerProps }) => (
              <div className="flex flex-col gap-3 sm:flex-row lg:flex-1">
                <div className="flex-1">
                  <span className="mb-1 block text-[11px] font-medium text-gray-500">Hotel check-in date</span>
                  <button
                    type="button"
                    ref={startTriggerProps.ref}
                    onClick={startTriggerProps.onClick}
                    aria-invalid={problem?.field === "night" || undefined}
                    className={`${fieldBase} ${fieldOk} flex items-center text-left`}
                  >
                    <CalendarIcon size={18} className="mr-2 flex-shrink-0 text-brand-blue opacity-80" aria-hidden="true" />
                    <span className={night ? "truncate font-medium" : "truncate text-gray-400"}>{night ? formatNightLabel(night) : "Check-in date"}</span>
                  </button>
                </div>
                <div className="flex-1">
                  <span className="mb-1 block text-[11px] font-medium text-gray-500">Parking return date</span>
                  <button
                    type="button"
                    ref={endTriggerProps.ref}
                    onClick={endTriggerProps.onClick}
                    aria-invalid={problem?.field === "return" || undefined}
                    className={`${fieldBase} ${fieldOk} flex items-center text-left`}
                  >
                    <CalendarIcon size={18} className="mr-2 flex-shrink-0 text-brand-blue opacity-80" aria-hidden="true" />
                    <span className={returnDate ? "truncate font-medium" : "truncate text-gray-400"}>
                      {returnDate ? formatNightLabel(returnDate) : "Return date"}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </DateRangePicker>

          <div className="grid grid-cols-3 gap-3 lg:flex lg:gap-3">
            <DetailSelect
              label="Arrive at the hotel"
              placeholder="Time"
              value={arrivalTime}
              options={ARRIVAL_TIME_OPTIONS}
              missing={arrivalTime.length === 0}
              onChange={setArrivalTime}
            />
            <DetailSelect
              label="Return time"
              placeholder="Time"
              value={returnTime}
              options={RETURN_TIME_OPTIONS}
              missing={returnTime.length === 0}
              onChange={setReturnTime}
            />
            <DetailSelect label="Guests" placeholder="Adults" value={adults} options={ADULT_OPTIONS} missing={adults.length === 0} onChange={setAdults} />
          </div>

          <button
            type="submit"
            className="whitespace-nowrap rounded-lg bg-brand-orange px-6 py-2.5 font-bold text-white shadow-sm transition-all hover:bg-orange-600 active:scale-95"
          >
            Search
          </button>
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
