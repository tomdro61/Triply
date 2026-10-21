"use client";

/**
 * /park-stay/[airport]/[hotelKey] — one hotel, priced fresh (plan v3 §8.1,
 * §8.4), laid out as mockup screen 8 (approved by Tom 20 Oct 2026): a hero
 * photo and header; on the left "Your trip" in three steps, the rooms as a
 * radio group, and the parking / hotel facts; on the right a sticky price
 * box itemising the SELECTED room (room, parking with tax, service fee, paid
 * at the hotel). Says "Price updated since your search" when the leading
 * total differs from the results card's `seen` value. Booking is disabled.
 * Every fact comes from the hotel API answer (card-facts.ts).
 */

import { useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BedDouble, Bus, Clock, ConciergeBell, Info, SquareParking } from "lucide-react";
import type { ParkStayHotelResponse } from "@/app/api/park-stay/hotel/route";
import type { HiddenReason } from "@/lib/hotels/search";
import { BUNDLE_CANCELLATION_NOTE } from "@/lib/hotels/refundability";
import { PARK_STAY_TOTAL_LABEL_INTERIM } from "@/lib/pricing/copy";
import { Button } from "@/components/ui/button";
import { FactRow, HotelPhoto, MetaLine, PreviewBanner, ScoreBadge, Tags } from "./hotel-facts";
import { SEARCH_PARAM_KEYS, formatCents, formatReslabDateTime } from "./format";
import { cancellationTag, metaParts, milesToAirport, priceChangeNote, priceLines, roomChoices, roomTags, shuttleFact, tripSteps } from "./card-facts";
import { readSearchValues } from "./search-results";
import { PREVIEW_UNAVAILABLE_MESSAGE } from "./results-state";
import { reportRejectedAnswer } from "./report";

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

export function ParkStayHotelDetail({
  airport,
  airportPoint,
  hotelKey,
  mapName,
}: {
  airport: string;
  /** The airport's point (@/config/airports) for the straight-line distance; null = not shown. */
  airportPoint: { latitude: number; longitude: number } | null;
  hotelKey: string;
  mapName: string;
}) {
  const params = useSearchParams();
  const values = useMemo(() => readSearchValues(params), [params]);
  const complete = SEARCH_PARAM_KEYS.every((k) => values[k].length > 0) && values.airport.toUpperCase() === airport.toUpperCase();
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
    // Back to results lands on this hotel's card.
    q.set("focus", hotelKey);
    return q.toString();
  }, [values, hotelKey]);
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
      {/* The loaded page puts the back link in its header, under the hero photo. */}
      {state.kind !== "ok" && <BackLink href={`/park-stay?${backQuery}`} />}
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
      {state.kind === "ok" && <HotelBody body={state.body} seen={seen} airport={airport} airportPoint={airportPoint} backHref={`/park-stay?${backQuery}`} />}
    </div>
  );
}

function BackLink({ href }: { href: string }) {
  return (
    <Link href={href} className="text-sm font-semibold text-brand-orange hover:underline">
      ← Back to results
    </Link>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="font-heading text-base font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

function PriceRow({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "border-t border-gray-200 pt-2 font-heading text-base font-bold text-gray-900" : "text-sm text-gray-700"}`}>
      <span>{label}</span>
      <span>{cents < 0 ? `−${formatCents(-cents)}` : formatCents(cents)}</span>
    </div>
  );
}

function HotelBody({
  body,
  seen,
  airport,
  airportPoint,
  backHref,
}: {
  body: Ok;
  seen: number | null;
  airport: string;
  airportPoint: { latitude: number; longitude: number } | null;
  backHref: string;
}) {
  const { hotel, leading, rooms, search } = body;
  const choices = roomChoices(leading, rooms);
  // The leading room starts selected; an id no longer in the list falls back to it.
  const [selectedId, setSelectedId] = useState(leading.offerRef.rateId);
  const selected = choices.find((r) => r.offerRef.rateId === selectedId) ?? leading;
  const radioName = useId();
  const changeNote = priceChangeNote({ seen, leading, selected });
  const lot = hotel.lot;
  const meta = metaParts({ stars: hotel.stars, miles: milesToAirport(lot, airportPoint), airportCode: airport, reviewCount: hotel.reviewCount });
  const shuttle = shuttleFact(lot, airport);
  const steps = tripSteps({ search, lot, airportCode: airport });
  const atHotel = [
    lot.roomCheckinTime ? { icon: <Clock className="h-4 w-4" />, text: `Room ready from ${lot.roomCheckinTime}` } : null,
    lot.roomCheckoutTime ? { icon: <Clock className="h-4 w-4" />, text: `Check-out by ${lot.roomCheckoutTime}` } : null,
    lot.frontDeskHours ? { icon: <ConciergeBell className="h-4 w-4" />, text: `Front desk: ${lot.frontDeskHours}` } : null,
  ].filter((x): x is { icon: ReactElement; text: string } => x !== null);
  const p = selected.price;

  return (
    <article className="space-y-4">
      <div className="relative h-48 overflow-hidden rounded-xl sm:h-64">
        <HotelPhoto url={hotel.photoUrl} name={hotel.name} sizes="(max-width: 1024px) 100vw, 1024px" eager />
      </div>
      <div>
        <BackLink href={backHref} />
        <h1 className="mt-1 font-heading text-2xl font-bold text-gray-900">{hotel.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <ScoreBadge rating={hotel.rating} className="!rounded-md !px-1.5 !text-xs" />
          <MetaLine parts={[...meta, ...(hotel.address ? [{ text: hotel.address }] : [])]} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Block title="Your trip">
            <ol className="flex flex-col gap-3">
              {steps.map((step, i) => (
                <li key={step.title} className="flex gap-3">
                  <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand-orange font-heading text-xs font-bold text-white" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="text-sm">
                    <b className="block font-heading font-semibold text-gray-900">{step.title}</b>
                    <span className="text-gray-600">{step.body}</span>
                  </div>
                </li>
              ))}
            </ol>
          </Block>

          {/* Native radios: arrow keys move the choice, the fieldset names the group. */}
          <fieldset className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-gray-200 bg-white p-4">
            <legend className="float-left mb-1 w-full font-heading text-base font-semibold text-gray-900">Choose your room</legend>
            {choices.map((room) => {
              const on = room.offerRef.rateId === selected.offerRef.rateId;
              return (
                <label
                  key={room.offerRef.rateId}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors focus-within:ring-2 focus-within:ring-brand-orange/40 ${
                    on ? "border-brand-orange bg-orange-50/40" : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <input
                    type="radio"
                    name={radioName}
                    value={room.offerRef.rateId}
                    checked={on}
                    onChange={() => setSelectedId(room.offerRef.rateId)}
                    className="mt-1 h-4 w-4 accent-brand-orange"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-center gap-1.5 font-heading text-sm font-semibold text-gray-900">
                      <BedDouble className="h-4 w-4 flex-shrink-0 text-gray-500" aria-hidden="true" />
                      {room.roomName}
                    </span>
                    {room.boardName && <span className="text-xs text-muted-foreground">{room.boardName}</span>}
                    <Tags tags={roomTags(room)} compact />
                  </span>
                  <span className="font-heading text-base font-bold text-gray-900">{formatCents(room.price.headlineTotalCents)}</span>
                </label>
              );
            })}
          </fieldset>

          <div className={`grid grid-cols-1 gap-4 ${atHotel.length > 0 ? "sm:grid-cols-2" : ""}`}>
            <Block title="Parking at the hotel">
              <ul className="flex flex-col gap-2 text-[13px] text-gray-700">
                <FactRow icon={<SquareParking className="h-4 w-4" />} lead={lot.name}>
                  · from {formatReslabDateTime(hotel.parking.fromDate)} to {formatReslabDateTime(hotel.parking.toDate)}
                </FactRow>
                <FactRow icon={<Bus className="h-4 w-4" />} lead={shuttle.lead}>
                  {shuttle.rest || null}
                  {lot.shuttleAvailable && lot.shuttleDetails && <span className="mt-0.5 block text-xs text-muted-foreground">{lot.shuttleDetails}</span>}
                </FactRow>
                {lot.specialConditions && (
                  <FactRow icon={<Info className="h-4 w-4" />}>
                    <details>
                      <summary className="cursor-pointer font-medium text-brand-orange">Show parking rules</summary>
                      <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{lot.specialConditions}</p>
                    </details>
                  </FactRow>
                )}
              </ul>
            </Block>
            {atHotel.length > 0 && (
              <Block title="At the hotel">
                <ul className="flex flex-col gap-2 text-[13px] text-gray-700">
                  {atHotel.map((f) => (
                    <FactRow key={f.text} icon={f.icon}>
                      {f.text}
                    </FactRow>
                  ))}
                </ul>
              </Block>
            )}
          </div>
        </div>

        {/* The price follows the selected room; under the details on a phone, sticky beside them on desktop. */}
        <aside aria-label="Your price" className="flex h-fit flex-col gap-2 rounded-xl border border-gray-200 bg-white p-4 lg:sticky lg:top-24">
          <h2 className="font-heading text-base font-semibold text-gray-900">Your price</h2>
          {/* Every non-zero component of packagePrice(), so the lines always add up to the total. */}
          {priceLines(p, selected.roomName).map((line) => (
            <PriceRow key={line.label} label={line.label} cents={line.cents} />
          ))}
          <PriceRow label="Total" cents={p.headlineTotalCents} strong />
          <p className="text-[11.5px] text-muted-foreground">{PARK_STAY_TOTAL_LABEL_INTERIM}</p>
          <Tags tags={[cancellationTag(selected.refundability)]} />
          {changeNote && <p className="rounded-md bg-muted px-3 py-2 text-sm">{changeNote}</p>}
          <p className="text-xs text-muted-foreground">{BUNDLE_CANCELLATION_NOTE}</p>
          <Button disabled className="mt-1 w-full">
            Booking opens soon
          </Button>
        </aside>
      </div>
    </article>
  );
}
