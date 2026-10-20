"use client";

/**
 * Park & Stay search form (plan v3 §4.1). Every field is required and starts
 * EMPTY unless the URL already carries it — no silent defaults: the arrival
 * time decides where parking starts, which can change the price by a whole
 * 24-hour block (§4.2).
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PARK_STAY_MAX_ADULTS, PARK_STAY_MIN_ADULTS } from "@/lib/hotels/plans";
import { ARRIVAL_TIME_OPTIONS, RETURN_TIME_OPTIONS, SEARCH_PARAM_KEYS, type SearchParamKey } from "./format";

export interface ParkStayAirportOption {
  code: string;
  name: string;
}

export type ParkStaySearchValues = Record<SearchParamKey, string>;

const fieldClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const labelClass = "mb-1 block text-xs font-medium text-muted-foreground";

const ADULT_OPTIONS = Array.from({ length: PARK_STAY_MAX_ADULTS - PARK_STAY_MIN_ADULTS + 1 }, (_, i) => String(PARK_STAY_MIN_ADULTS + i));

export function ParkStaySearchForm({ airports, initial }: { airports: ParkStayAirportOption[]; initial: ParkStaySearchValues }) {
  const router = useRouter();
  const [values, setValues] = useState<ParkStaySearchValues>(initial);
  const set = (k: SearchParamKey) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }));

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const k of SEARCH_PARAM_KEYS) q.set(k, values[k]);
    router.push(`/park-stay?${q.toString()}`);
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-7">
      <label className="lg:col-span-1">
        <span className={labelClass}>Airport</span>
        <select required value={values.airport} onChange={set("airport")} className={fieldClass}>
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
      <label>
        <span className={labelClass}>Hotel night</span>
        <input required type="date" value={values.night} onChange={set("night")} className={fieldClass} />
      </label>
      <label>
        <span className={labelClass}>Arrive at the hotel</span>
        <select required value={values.arrivalTime} onChange={set("arrivalTime")} className={fieldClass}>
          <option value="" disabled>
            Choose
          </option>
          {ARRIVAL_TIME_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className={labelClass}>Return date</span>
        <input required type="date" value={values.returnDate} onChange={set("returnDate")} className={fieldClass} />
      </label>
      <label>
        <span className={labelClass}>Collect your car</span>
        <select required value={values.returnTime} onChange={set("returnTime")} className={fieldClass}>
          <option value="" disabled>
            Choose
          </option>
          {RETURN_TIME_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className={labelClass}>Adults</span>
        <select required value={values.adults} onChange={set("adults")} className={fieldClass}>
          <option value="" disabled>
            Choose
          </option>
          {ADULT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end">
        <Button type="submit" className="w-full">
          Search
        </Button>
      </div>
    </form>
  );
}
