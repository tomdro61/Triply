"use client";

/**
 * /park-stay — the form and, when every input is present, the results
 * (plan v3 §8.1). Mirrors (main)/search/page.tsx: the client fetches the API.
 * With any input missing it shows the form and no price. No GA4 events.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ParkStaySearchResponse } from "@/app/api/park-stay/search/route";
import { ParkStaySearchForm, type ParkStayAirportOption, type ParkStaySearchValues } from "./search-form";
import { OfferCard } from "./offer-card";
import { PreviewBanner } from "./hotel-facts";
import { SEARCH_PARAM_KEYS, formatIsoDay } from "./format";

type Settled = { kind: "error"; message: string; retry: boolean } | { kind: "done"; body: ParkStaySearchResponse };
type State = { kind: "idle" } | { kind: "loading" } | Settled;

const UNAVAILABLE: Settled = { kind: "error", message: "Hotel search is temporarily unavailable.", retry: true };

async function fetchSearch(query: string): Promise<Settled> {
  try {
    const res = await fetch(`/api/park-stay/search?${query}`, { cache: "no-store" });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) return isSearchResponse(body) ? { kind: "done", body } : UNAVAILABLE;
    if (res.status === 400 || res.status === 404) return { kind: "error", message: errorMessage(body, "Check your search."), retry: false };
    if (res.status === 429) return { kind: "error", message: "Too many searches — please wait a moment.", retry: true };
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

const EMPTY_COPY: Record<NonNullable<ParkStaySearchResponse["emptyReason"]>, string> = {
  min_stay: "No Park & Stay available for these dates — the hotels here need a longer parking stay.",
  booking_window: "No Park & Stay available for these dates — they are outside the booking window.",
  sold_out: "No Park & Stay available for these dates — the hotels or their parking are sold out.",
  none_available: "No Park & Stay available for these dates.",
};

/** The URL's values, verbatim — a missing one stays "" (the form shows it unselected; nothing is defaulted). */
export function readSearchValues(params: { get(name: string): string | null }): ParkStaySearchValues {
  return {
    airport: params.get("airport") ?? "",
    night: params.get("night") ?? "",
    arrivalTime: params.get("arrivalTime") ?? "",
    returnDate: params.get("returnDate") ?? "",
    returnTime: params.get("returnTime") ?? "",
    adults: params.get("adults") ?? "",
  };
}

function isSearchResponse(body: unknown): body is ParkStaySearchResponse {
  return (
    typeof body === "object" &&
    body !== null &&
    "status" in body &&
    (body.status === "ok" || body.status === "empty") &&
    "offers" in body &&
    Array.isArray(body.offers)
  );
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return fallback;
}

export function ParkStaySearchResults({ airports }: { airports: ParkStayAirportOption[] }) {
  const params = useSearchParams();
  const values = useMemo<ParkStaySearchValues>(() => readSearchValues(params), [params]);
  const complete = SEARCH_PARAM_KEYS.every((k) => values[k].length > 0);
  const query = useMemo(() => {
    const q = new URLSearchParams();
    for (const k of SEARCH_PARAM_KEYS) q.set(k, values[k]);
    return q.toString();
  }, [values]);
  // Results are keyed by (query, attempt): the state is DERIVED, so a new
  // search or a retry shows "loading" without a synchronous setState in an effect.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ query: string; attempt: number; state: Settled } | null>(null);

  useEffect(() => {
    if (!complete) return;
    let cancelled = false;
    void fetchSearch(query).then((settled) => {
      if (!cancelled) setResult({ query, attempt, state: settled });
    });
    return () => {
      cancelled = true;
    };
  }, [complete, query, attempt]);

  const state: State = !complete
    ? { kind: "idle" }
    : result && result.query === query && result.attempt === attempt
      ? result.state
      : { kind: "loading" };
  const retry = () => setAttempt((a) => a + 1);

  return (
    <div className="space-y-4">
      <PreviewBanner />
      <ParkStaySearchForm key={query} airports={airports} initial={values} />
      {state.kind === "loading" && <p className="text-sm text-muted-foreground">Checking hotels and their parking…</p>}
      {state.kind === "error" && (
        <div className="rounded-md border p-4 text-sm">
          <p>{state.message}</p>
          {state.retry && (
            <button type="button" onClick={retry} className="mt-2 font-medium text-primary hover:underline">
              Try again
            </button>
          )}
        </div>
      )}
      {state.kind === "done" && (
        <section className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Hotel night {formatIsoDay(state.body.search.night)}, check-out and departure {formatIsoDay(state.body.search.departureDate)}. Parking from {state.body.search.arrivalTime} on {formatIsoDay(state.body.search.night)} to {state.body.search.returnTime} on {formatIsoDay(state.body.search.returnDate)}.
          </p>
          {state.body.partial && <p className="rounded-md bg-muted px-3 py-2 text-sm">Some hotels couldn&apos;t be checked right now.</p>}
          {state.body.offers.length === 0 ? (
            <p className="rounded-md border p-4 text-sm">{EMPTY_COPY[state.body.emptyReason ?? "none_available"]}</p>
          ) : (
            state.body.offers.map((card) => (
              <OfferCard key={card.hotelKey} card={card} returnDate={state.body.search.returnDate} searchQuery={query} airport={state.body.airport.code} />
            ))
          )}
        </section>
      )}
    </div>
  );
}
