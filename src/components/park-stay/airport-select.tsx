"use client";

import { ChevronDown, MapPin } from "lucide-react";

/**
 * The Park & Stay airport field: AirportCombobox's look (CX plan §12.2 —
 * the same box, MapPin and chevron, `hero` and `compact` variants, classes
 * copied), but a native select limited to the open airports. The shared
 * combobox lists every airport and is a customer component, so it is not
 * changed for this.
 */
export function ParkStayAirportSelect({
  value,
  onChange,
  airports,
  variant,
  invalid = false,
  label,
}: {
  value: string;
  onChange: (code: string) => void;
  airports: readonly { code: string; name: string }[];
  variant: "hero" | "compact";
  invalid?: boolean;
  /** The accessible name (the visible label sits outside, in the hero). */
  label: string;
}) {
  const isHero = variant === "hero";
  const box = isHero
    ? "pl-10 pr-10 py-3 bg-gray-50 border border-gray-200 rounded-lg group-hover:bg-white transition-colors"
    : "pl-10 pr-10 py-2.5 bg-gray-50 border border-gray-200 rounded-lg focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent transition-all text-sm font-semibold";
  return (
    <div className="relative w-full">
      <MapPin className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-blue opacity-80" size={isHero ? 20 : 18} aria-hidden="true" />
      <select
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full cursor-pointer appearance-none text-left outline-none ${box} ${value ? "font-medium text-gray-900" : "text-gray-400"}`}
      >
        <option value="" disabled>
          Choose an airport
        </option>
        {airports.map((a) => (
          <option key={a.code} value={a.code} className="text-gray-900">
            {isHero ? `${a.code} - ${a.name}` : `${a.code} — ${a.name}`}
          </option>
        ))}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
    </div>
  );
}
