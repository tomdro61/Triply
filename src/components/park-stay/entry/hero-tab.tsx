"use client";

/**
 * The homepage Hero's "Park & Stay" tab (CX plan §2, as changed by §11 and
 * §12.3; mockup screen 1). Loaded lazily by slots/hero-tab-slot.tsx, which
 * owns the access answer (one owner: review of PR B, item 1). The Hero
 * renders this once, in its tab strip: it draws the tab button there and,
 * while active, portals the form into the Hero's content area
 * (HeroExtraTabContext.panel). A form that throws reaches the slot's
 * boundary, which resets the Hero to Parking.
 *
 * The form asks the airport (the access airports only), the HOTEL CHECK-IN
 * date (`night`) and the PARKING RETURN date (`returnDate`): check-in from
 * today at the airport, return within 60 days of it — an error, never a
 * swap. Arrival time, return time and guests get their starting values on
 * /park-stay (withSearchDefaults). Styling is the Hero's own, classes copied.
 */

import { useContext, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { BedDouble, Calendar as CalendarIcon } from "lucide-react";
import { DateRangePicker } from "@/components/ui/date-picker";
import { HeroExtraTabContext } from "@/components/shared/hero-extra-tab";
import type { ParkStayAccess } from "@/lib/hotels/access";
import { ParkStayAirportSelect } from "../airport-select";
import { formatNightLabel } from "../format";
import { PARK_STAY_WINDOW_NOTE, RETURN_BEFORE_CHECKIN, isPickerSwap, pickerDate, type DatesProblem } from "../search-values";
import { accessAirportOptions, heroDateLimits, heroSubmit } from "./hero-dates";

export function ParkStayHeroTab({ access }: { access: ParkStayAccess }) {
  const ctx = useContext(HeroExtraTabContext);
  if (!ctx) return null;
  return (
    <>
      <TabButton active={ctx.active} onSelect={ctx.select} />
      {ctx.active && ctx.panel && createPortal(<HeroTabForm access={access} />, ctx.panel)}
    </>
  );
}

function TabButton({ active, onSelect }: { active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex items-center justify-center px-6 py-4 flex-1 transition-colors text-sm md:text-base font-medium
                    ${active ? "bg-white text-brand-orange border-b-2 border-brand-orange" : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"}
                  `}
    >
      <BedDouble size={18} className={`mr-2 ${active ? "stroke-2" : "stroke-1"}`} aria-hidden="true" />
      Park &amp; Stay
    </button>
  );
}

const fieldBox = "py-3 px-3 bg-gray-50 border border-gray-200 rounded-lg group-hover:bg-white transition-colors";
const labelClass = "block text-xs font-bold text-gray-500 uppercase mb-1";

function HeroTabForm({ access }: { access: ParkStayAccess }) {
  const router = useRouter();
  const airports = useMemo(() => accessAirportOptions(access), [access]);
  const [airport, setAirport] = useState("");
  const [night, setNight] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [problem, setProblem] = useState<DatesProblem | null>(null);
  // The start the picker sent in THIS click (isPickerSwap); cleared by the end that follows.
  const pendingStart = useRef<{ start: string; prevStart: string } | null>(null);

  // Read on every render, so a page left open past midnight moves with the airport's day.
  const limits = heroDateLimits({ airport, night, returnDate }, airports, new Date());

  function onCheckinChange(v: string) {
    pendingStart.current = { start: v, prevStart: night };
    setNight(v);
    setProblem(null);
  }

  function onReturnChange(v: string) {
    const pending = pendingStart.current;
    pendingStart.current = null;
    if (pending && isPickerSwap(pending, v)) {
      // The shared picker swapped a return picked before the check-in: keep both as they were, and say why.
      setNight(pending.prevStart);
      setProblem({ field: "return", message: RETURN_BEFORE_CHECKIN });
      return;
    }
    setReturnDate(v);
    setProblem(null);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const out = heroSubmit({ airport, night, returnDate }, airports, new Date());
    if (!out.ok) {
      setProblem(out.problem);
      return;
    }
    setProblem(null);
    router.push(out.href);
  }

  return (
    <form onSubmit={submit} noValidate className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end animate-fade-in">
      <div className="md:col-span-4 relative group">
        <span className={labelClass} aria-hidden="true">
          Airport
        </span>
        <ParkStayAirportSelect
          value={airport}
          onChange={(code) => {
            setAirport(code);
            setProblem(null);
          }}
          airports={airports}
          variant="hero"
          invalid={problem?.field === "airport"}
          label="Airport"
        />
      </div>

      <DateRangePicker
        startDate={night}
        endDate={returnDate}
        onStartChange={onCheckinChange}
        onEndChange={onReturnChange}
        minDate={pickerDate(limits.min)}
        maxDate={pickerDate(limits.max)}
        windowNote={PARK_STAY_WINDOW_NOTE}
      >
        {({ startTriggerProps, endTriggerProps }) => (
          <>
            <div className="md:col-span-3 relative group">
              <span className={labelClass} aria-hidden="true">
                Hotel check-in date
              </span>
              <div className={fieldBox}>
                <button
                  type="button"
                  ref={startTriggerProps.ref}
                  onClick={startTriggerProps.onClick}
                  aria-label={night ? `Hotel check-in date, ${formatNightLabel(night)}` : "Hotel check-in date"}
                  aria-invalid={problem?.field === "night" || undefined}
                  className="flex items-center w-full text-left cursor-pointer"
                >
                  <CalendarIcon size={20} className="mr-2 text-brand-blue opacity-80 flex-shrink-0" aria-hidden="true" />
                  <span className={night ? "text-gray-900 font-medium truncate" : "text-gray-400 truncate"}>{night ? formatNightLabel(night) : "Check-in date"}</span>
                </button>
              </div>
            </div>

            <div className="md:col-span-3 relative group">
              <span className={labelClass} aria-hidden="true">
                Parking return date
              </span>
              <div className={fieldBox}>
                <button
                  type="button"
                  ref={endTriggerProps.ref}
                  onClick={endTriggerProps.onClick}
                  aria-label={returnDate ? `Parking return date, ${formatNightLabel(returnDate)}` : "Parking return date"}
                  aria-invalid={problem?.field === "return" || undefined}
                  className="flex items-center w-full text-left cursor-pointer"
                >
                  <CalendarIcon size={20} className="mr-2 text-brand-blue opacity-80 flex-shrink-0" aria-hidden="true" />
                  <span className={returnDate ? "text-gray-900 font-medium truncate" : "text-gray-400 truncate"}>
                    {returnDate ? formatNightLabel(returnDate) : "Return date"}
                  </span>
                </button>
              </div>
            </div>
          </>
        )}
      </DateRangePicker>

      <div className="md:col-span-2">
        <button
          type="submit"
          className="w-full bg-brand-orange hover:bg-brand-orange/90 text-white font-bold py-3 px-4 rounded-lg shadow-md hover:shadow-lg transition-all transform active:scale-95 h-[50px]"
        >
          Search
        </button>
      </div>

      <div className="md:col-span-12 space-y-1 text-sm">
        {night && returnDate && !problem && (
          <p className="text-gray-600">
            One night at the hotel on <b className="text-gray-900">{formatNightLabel(night)}</b>, then parking there until you&apos;re back on{" "}
            <b className="text-gray-900">{formatNightLabel(returnDate)}</b>. Arrival time, return time and guests come next.
          </p>
        )}
        {problem && (
          <p role="alert" className="font-medium text-red-600">
            {problem.message}
          </p>
        )}
      </div>
    </form>
  );
}
