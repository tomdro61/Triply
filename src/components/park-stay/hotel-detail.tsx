"use client";

/**
 * /park-stay/[airport]/[hotelKey] — one hotel, priced fresh (plan v3 §8.1,
 * §8.4). Itemises room, parking (with tax), service fee and fees paid at the
 * hotel; says "Price updated since your search" when the leading total
 * differs from the results card's `seen` value. Booking is disabled.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ParkStayHotelResponse } from "@/app/api/park-stay/hotel/route";
import type { HiddenReason, ParkStayRoomOffer } from "@/lib/hotels/search";
import { BUNDLE_CANCELLATION_NOTE } from "@/lib/hotels/refundability";
import { Button } from "@/components/ui/button";
import { PackagePrice } from "./package-price";
import { HotelPhoto, HotelRatingLine, PreviewBanner, RoomTimesLine, ShuttleLine } from "./hotel-facts";
import { SEARCH_PARAM_KEYS, formatCents, formatIsoDay, formatReslabDateTime } from "./format";
import { readSearchValues } from "./search-results";
import { PREVIEW_UNAVAILABLE_MESSAGE } from "./results-state";
import { reportRejectedAnswer } from "./report";
import { resolveFlight } from "./search-values";

type Ok = Extract<ParkStayHotelResponse, { status: "ok" }>;

type Settled = { kind: "error"; message: string; retry: boolean } | { kind: "unavailable"; reason: HiddenReason } | { kind: "ok"; body: Ok };
type State = { kind: "missing_inputs" } | { kind: "loading" } | Settled;

function isHotelResponse(body: unknown): body is ParkStayHotelResponse {
  return typeof body === "object" && body !== null && "status" in body && (body.status === "ok" || body.status === "unavailable");
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return fallback;
}

const UNAVAILABLE: Settled = { kind: "error", message: "Hotel search is temporarily unavailable.", retry: true };

async function fetchHotel(query: string): Promise<Settled> {
  try {
    const res = await fetch(`/api/park-stay/hotel?${query}`, { cache: "no-store" });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      if (!isHotelResponse(body)) {
        reportRejectedAnswer("/api/park-stay/hotel", res.status);
        return UNAVAILABLE;
      }
      return body.status === "ok" ? { kind: "ok", body } : { kind: "unavailable", reason: body.reason };
    }
    // A 404 here is the server's admin check failing this time (the page itself rendered), not a bad search.
    if (res.status === 404) return { kind: "error", message: PREVIEW_UNAVAILABLE_MESSAGE, retry: true };
    if (res.status === 400) return { kind: "error", message: errorMessage(body, "Check your search."), retry: false };
    if (res.status === 429) return { kind: "error", message: "Too many requests — please wait a moment.", retry: true };
    return UNAVAILABLE;
  } catch (err) {
    console.warn("[park-stay] hotel request failed:", err instanceof Error ? err.name : String(err));
    return UNAVAILABLE;
  }
}

/** Only an explicit sold-out reads as "no availability"; anything else stays neutral. */
export function unavailableCopy(reason: HiddenReason, mapName: string): string {
  if (reason === "parking_sold_out" || reason === "no_room") return `${mapName} has no Park & Stay available for these dates.`;
  if (reason === "no_rates_returned") return "No rooms were returned for these dates.";
  if (reason === "min_stay") return `${mapName}'s parking needs a longer stay for these dates.`;
  return `${mapName} isn't available for these dates right now.`;
}

function RoomRow({ room, returnDate }: { room: ParkStayRoomOffer; returnDate: string }) {
  const p = room.price;
  return (
    <li className="grid grid-cols-1 gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_auto]">
      <div className="space-y-1 text-sm">
        <p className="font-medium">
          {room.roomName}
          {room.boardName ? ` · ${room.boardName}` : ""}
        </p>
        <p className="text-xs text-muted-foreground">{room.refundabilitySummary}</p>
        <dl className="mt-2 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-xs">
          <dt>Room (1 night)</dt>
          <dd className="text-right">{formatCents(p.roomSellCents)}</dd>
          <dt>Parking, incl. tax</dt>
          <dd className="text-right">{formatCents(p.parkingOnlineCents)}</dd>
          <dt>Service fee</dt>
          <dd className="text-right">{formatCents(p.serviceFeeCents)}</dd>
          {p.propertyFeesDueAtHotelCents > 0 && (
            <>
              <dt>Paid at the hotel</dt>
              <dd className="text-right">{formatCents(p.propertyFeesDueAtHotelCents)}</dd>
            </>
          )}
        </dl>
      </div>
      <PackagePrice price={p} returnDate={returnDate} />
    </li>
  );
}

export function ParkStayHotelDetail({ airport, hotelKey, mapName }: { airport: string; hotelKey: string; mapName: string }) {
  const params = useSearchParams();
  const values = useMemo(() => readSearchValues(params), [params]);
  const complete = SEARCH_PARAM_KEYS.every((k) => values[k].length > 0) && values.airport.toUpperCase() === airport.toUpperCase();
  const flightParam = params.get("flight");
  const seenRaw = params.get("seen");
  const seen = seenRaw !== null && /^\d{1,9}$/.test(seenRaw) ? Number(seenRaw) : null; // display-only
  const query = useMemo(() => {
    const q = new URLSearchParams();
    for (const k of SEARCH_PARAM_KEYS) q.set(k, values[k]);
    q.set("hotelKey", hotelKey);
    return q.toString();
  }, [values, hotelKey]);
  const backQuery = useMemo(() => {
    const q = new URLSearchParams();
    for (const k of SEARCH_PARAM_KEYS) q.set(k, values[k]);
    // The page-only flight date rides back to the results (it is never sent to the API).
    const flight = resolveFlight(flightParam, values.night);
    if (flight) q.set("flight", flight);
    q.set("focus", hotelKey);
    return q.toString();
  }, [values, flightParam, hotelKey]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ query: string; attempt: number; state: Settled } | null>(null);

  useEffect(() => {
    if (!complete) return;
    let cancelled = false;
    void fetchHotel(query).then((settled) => {
      if (!cancelled) setResult({ query, attempt, state: settled });
    });
    return () => {
      cancelled = true;
    };
  }, [complete, query, attempt]);

  const state: State = !complete
    ? { kind: "missing_inputs" }
    : result && result.query === query && result.attempt === attempt
      ? result.state
      : { kind: "loading" };
  const retry = () => setAttempt((a) => a + 1);

  return (
    <div className="space-y-4">
      <PreviewBanner />
      <Link href={`/park-stay?${backQuery}`} className="text-sm text-primary hover:underline">
        ← Back to results
      </Link>
      {state.kind === "missing_inputs" && (
        <p className="rounded-md border p-4 text-sm">
          {mapName}: choose your dates and times on the <Link href="/park-stay" className="text-primary hover:underline">Park &amp; Stay search</Link> to see prices.
        </p>
      )}
      {state.kind === "loading" && <p className="text-sm text-muted-foreground">Checking {mapName} and its parking…</p>}
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
      {state.kind === "unavailable" && <p className="rounded-md border p-4 text-sm">{unavailableCopy(state.reason, mapName)}</p>}
      {state.kind === "ok" && <HotelBody body={state.body} seen={seen} />}
    </div>
  );
}

function HotelBody({ body, seen }: { body: Ok; seen: number | null }) {
  const { hotel, leading, rooms, search } = body;
  const changed = seen !== null && seen !== leading.price.headlineTotalCents;
  return (
    <article className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[280px_1fr]">
        <HotelPhoto url={hotel.photoUrl} name={hotel.name} />
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-bold">{hotel.name}</h1>
          <HotelRatingLine stars={hotel.stars} rating={hotel.rating} reviewCount={hotel.reviewCount} />
          {hotel.address && <p className="text-sm text-muted-foreground">{hotel.address}</p>}
          <p className="text-sm">Parking at the hotel: {hotel.lot.name}</p>
          <ShuttleLine lot={hotel.lot} detailed />
          <RoomTimesLine lot={hotel.lot} />
          <p className="text-sm">
            Parking from {formatReslabDateTime(hotel.parking.fromDate)} to {formatReslabDateTime(hotel.parking.toDate)}. Hotel night {formatIsoDay(search.night)}, check-out {formatIsoDay(search.departureDate)}.
          </p>
          {hotel.lot.specialConditions && <p className="text-xs text-muted-foreground">Parking rules: {hotel.lot.specialConditions}</p>}
        </div>
      </div>
      {changed && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">Price updated since your search (was {formatCents(seen)}).</p>
      )}
      <ul className="space-y-3">
        {rooms.map((r) => (
          <RoomRow key={r.roomKey} room={r} returnDate={search.returnDate} />
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{BUNDLE_CANCELLATION_NOTE}</p>
      <Button disabled className="w-full sm:w-auto">
        Booking opens soon
      </Button>
    </article>
  );
}
