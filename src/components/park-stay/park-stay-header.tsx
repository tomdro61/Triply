"use client";

/**
 * The /park-stay search header (CX plan v2 §3), replacing the native form.
 *
 * - The flight date comes first, then the return date (the shared
 *   DateRangePicker). The hotel night = flight − 1, shown as "You'll stay
 *   the night of …" and editable (red-eyes); the NIGHT is what goes in the URL.
 * - Flight minimum = tomorrow at the AIRPORT (a flight today would put the
 *   night in the past); return maximum = the night + 60 days (plans.ts).
 * - Arrival time, return time and adults start EMPTY unless the URL has them
 *   — no defaults; a missing one is highlighted with the prompt, and the
 *   results stay idle (no fetch) until all are set.
 * - Every submit keeps `focus`.
 * - Mobile: a collapsed summary bar (a button) over an expandable form; the
 *   mode toggle sits OUTSIDE that button (a link inside a button is invalid).
 *
 * The parent re-keys this on the URL, so its state always starts from what
 * was searched.
 */

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Calendar as CalendarIcon, ChevronDown, ChevronUp, MapPin, SlidersHorizontal } from "lucide-react";
import { DateRangePicker } from "@/components/ui/date-picker";
import { PARK_STAY_MAX_ADULTS, PARK_STAY_MIN_ADULTS } from "@/lib/hotels/plans";
import { ARRIVAL_TIME_OPTIONS, RETURN_TIME_OPTIONS, formatNightLabel } from "./format";
import { ParkStayModeToggle } from "./mode-toggle";
import {
  checkSearchDates,
  detailsPrompt,
  flightDateForNight,
  missingDetails,
  nightChoices,
  nightForFlightDate,
  parkStayDateBounds,
  parkStayPageQuery,
  pickerMaxDate,
  type DatesProblem,
  type ParkStayAirportOption,
  type ParkStaySearchValues,
} from "./search-values";

const ADULT_OPTIONS = Array.from({ length: PARK_STAY_MAX_ADULTS - PARK_STAY_MIN_ADULTS + 1 }, (_, i) => String(PARK_STAY_MIN_ADULTS + i));
// Only for the picker's limits before an airport is chosen (every open
// airport is in New York today); a submit needs an airport, and then its own
// timezone sets the limits. Never a booking value.
const FALLBACK_TIME_ZONE = "America/New_York";

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
  /** What the URL searched (verbatim; "" = missing). */
  values: ParkStaySearchValues;
  focus: string | null;
  parkingHref: string | null;
  currentHref: string;
}) {
  const router = useRouter();
  const [airport, setAirport] = useState(values.airport.toUpperCase());
  const [flight, setFlight] = useState(flightDateForNight(values.night) ?? "");
  const [night, setNight] = useState(flightDateForNight(values.night) ? values.night : "");
  const [returnDate, setReturnDate] = useState(values.returnDate);
  const [arrivalTime, setArrivalTime] = useState(values.arrivalTime);
  const [returnTime, setReturnTime] = useState(values.returnTime);
  const [adults, setAdults] = useState(values.adults);
  const [editingNight, setEditingNight] = useState(false);
  const [problem, setProblem] = useState<DatesProblem | null>(null);
  const missing = missingDetails({ arrivalTime, returnTime, adults });
  // Mobile: open when something is still to fill in, collapsed once searched.
  const [expanded, setExpanded] = useState(!(airport && flight && returnDate) || missing.length > 0);

  const timeZone = airports.find((a) => a.code === airport)?.timezone ?? FALLBACK_TIME_ZONE;
  // "Today" at the airport, read once per airport — not a render-time default
  // for any booking value, only the picker's limits.
  const bounds = useMemo(() => parkStayDateBounds(timeZone, new Date()), [timeZone]);
  const maxPick = pickerMaxDate({ flight, night, returnDate }, bounds);
  const choices = nightChoices(flight, bounds.today);
  const prompt = detailsPrompt(missing);

  function onFlightChange(v: string) {
    setFlight(v);
    setNight(nightForFlightDate(v) ?? "");
    setEditingNight(false);
    setProblem(null);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const p = checkSearchDates({ airport, flight, night, returnDate }, bounds);
    if (p) {
      setProblem(p);
      return;
    }
    setProblem(null);
    // Missing details still navigate: the URL then shows exactly what is set,
    // and the results stay idle with the highlight until the rest is chosen.
    const next = parkStayPageQuery({ airport, night, arrivalTime, returnDate, returnTime, adults }, focus);
    router.push(`/park-stay?${next}`);
    if (missing.length === 0) setExpanded(false);
  }

  const summaryDates = flight ? `${formatNightLabel(flight)} — ${returnDate ? formatNightLabel(returnDate) : "Return"}` : "Add your dates";

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
            startDate={flight}
            endDate={returnDate}
            onStartChange={onFlightChange}
            onEndChange={(v) => {
              setReturnDate(v);
              setProblem(null);
            }}
            minDate={pickerDate(bounds.flightMin)}
            maxDate={pickerDate(maxPick)}
          >
            {({ startTriggerProps, endTriggerProps }) => (
              <div className="flex flex-col gap-3 sm:flex-row lg:flex-1">
                <div className="flex-1">
                  <span className="mb-1 block text-[11px] font-medium text-gray-500">Flight date</span>
                  <button
                    type="button"
                    ref={startTriggerProps.ref}
                    onClick={startTriggerProps.onClick}
                    aria-invalid={problem?.field === "flight" || undefined}
                    className={`${fieldBase} ${fieldOk} flex items-center text-left`}
                  >
                    <CalendarIcon size={18} className="mr-2 flex-shrink-0 text-brand-blue opacity-80" aria-hidden="true" />
                    <span className={flight ? "truncate font-medium" : "truncate text-gray-400"}>{flight ? formatNightLabel(flight) : "Flight date"}</span>
                  </button>
                </div>
                <div className="flex-1">
                  <span className="mb-1 block text-[11px] font-medium text-gray-500">Return date</span>
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
              label="Reach the hotel"
              placeholder="Time"
              value={arrivalTime}
              options={ARRIVAL_TIME_OPTIONS}
              missing={arrivalTime.length === 0}
              onChange={setArrivalTime}
            />
            <DetailSelect
              label="Collect your car"
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
          {night && (
            <p className="text-gray-700">
              You&apos;ll stay the night of <strong>{formatNightLabel(night)}</strong>
              {choices.length > 1 && !editingNight && (
                <>
                  {" · "}
                  <button type="button" onClick={() => setEditingNight(true)} className="font-medium text-primary hover:underline">
                    change
                  </button>
                </>
              )}
            </p>
          )}
          {editingNight && choices.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Hotel night</span>
                <select
                  value={night}
                  onChange={(e) => {
                    setNight(e.target.value);
                    setProblem(null);
                  }}
                  aria-invalid={problem?.field === "night" || undefined}
                  className={`${fieldBase} ${fieldOk} w-auto py-1.5`}
                >
                  {choices.map((n) => (
                    <option key={n} value={n}>
                      {formatNightLabel(n)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {night && choices.length > 1 && (
            <p className="text-xs text-gray-500">Flight just after midnight? Pick the night you&apos;ll actually sleep at the hotel.</p>
          )}
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
