"use client";

/**
 * /park-stay — the header and, when every input is present, the results as
 * a list plus map (CX plan v2 §3; Phase A plan v3 §8.1). Mirrors
 * (main)/search/page.tsx: the client fetches the API; desktop shows the list
 * (2/5) beside the map (3/5), the map mounted only at lg+; mobile shows the
 * list with a Map button that opens a full-screen map and a snap carousel.
 * Values the URL left out get starting values (withSearchDefaults); only a
 * missing airport (or a return with no check-in) leaves the header asking,
 * and then it fetches nothing. No GA4 events.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { List, Map as MapIcon } from "lucide-react";
import type { ParkStayCard } from "@/lib/hotels/search";
import { todayInZone } from "@/lib/hotels/dates";
import { MapPlaceholder } from "@/components/map/map-placeholder";
import { useMediaQuery } from "@/hooks/use-media-query";
import { PreviewBanner } from "./hotel-facts";
import { ParkStayHeader } from "./park-stay-header";
import { ParkStayMapCard, ParkStayResultCard, cardElementId, hotelHref, mapCardElementId } from "./park-stay-card";
import { LazyParkStayMap } from "./lazy-park-stay-map";
import { reportRejectedAnswer } from "./report";
import { MapErrorBoundary } from "./map-error-boundary";
import type { ParkStayPin } from "./park-stay-map";
import { formatCents, formatIsoDay } from "./format";
import { UNAVAILABLE, classifySearchAnswer, deriveResultsState, listContent, type Settled } from "./results-state";
import {
  apiSearchQuery,
  focusBanner,
  isCompleteSearch,
  parkingOnlySide,
  parkStayPageQuery,
  readFocus,
  sanitizeSearchValues,
  withSearchDefaults,
  type ParkStayAirportOption,
  type ParkStayHotelName,
  type ParkStaySearchValues,
  airportTimeZone,
} from "./search-values";

const NO_OFFERS: readonly ParkStayCard[] = [];

async function fetchSearch(query: string): Promise<Settled> {
  try {
    const res = await fetch(`/api/park-stay/search?${query}`, { cache: "no-store" });
    const body: unknown = await res.json().catch(() => null);
    const settled = classifySearchAnswer(res.status, body);
    // A 2xx the strict check refused shows as "unavailable" — leave a trace
    // so it never looks like an unexplained outage (admin-only, low volume).
    if (res.ok && settled.kind !== "done") reportRejectedAnswer("/api/park-stay/search", res.status);
    return settled;
  } catch (err) {
    console.warn("[park-stay] search request failed:", err instanceof Error ? err.name : String(err));
    return UNAVAILABLE;
  }
}

/**
 * The URL's values, verbatim — a missing one stays "" (nothing is defaulted).
 * Both pages then fill starting values (withSearchDefaults); this page
 * sanitises first (sanitizeSearchValues) so an off-list value is replaced,
 * while the hotel page sends it as is and the server answers 400.
 */
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

function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
      {title && <p className="mb-1 font-semibold text-gray-900">{title}</p>}
      {children}
    </div>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-3 rounded-full bg-brand-orange px-5 py-2 text-sm font-semibold text-white transition-transform active:scale-95">
      Try again
    </button>
  );
}

export function ParkStaySearchResults({ airports, hotels }: { airports: ParkStayAirportOption[]; hotels: ParkStayHotelName[] }) {
  const params = useSearchParams();
  const openCodes = useMemo(() => airports.map((a) => a.code), [airports]);
  // Values the URL left out get their starting values (withSearchDefaults), so
  // the header shows them filled in and the search runs at once. The clock is
  // read when the URL changes, not on every render, so the query stays stable.
  const values = useMemo<ParkStaySearchValues>(() => {
    const clean = sanitizeSearchValues(readSearchValues(params), openCodes);
    return withSearchDefaults(clean, { timeZone: airportTimeZone(airports, clean.airport), now: new Date(), fillDates: true });
  }, [params, openCodes, airports]);
  const focus = readFocus(params);
  const complete = isCompleteSearch(values);
  const query = useMemo(() => apiSearchQuery(values), [values]);
  // Results are keyed by (query, attempt): the state is DERIVED, so a new
  // search or a retry shows "loading" without a synchronous setState in an effect.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ query: string; attempt: number; state: Settled } | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "map">("list");
  const carouselRef = useRef<HTMLDivElement>(null);
  // As on the parking page: the side-by-side map exists only at lg+, so it is
  // mounted only there (a hidden mounted map still boots mapbox-gl on phones).
  const isDesktop = useMediaQuery("(min-width: 1024px)");

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

  const state = deriveResultsState({ complete, query, attempt, result });
  const retry = () => setAttempt((a) => a + 1);

  // The stored answer when it is the one shown (the same reference
  // deriveResultsState returned), so the pins are only rebuilt when a new
  // answer arrives — not on every hover.
  const shown = result !== null && state === result.state ? result.state : null;
  const offers = useMemo(() => (shown?.kind === "done" ? shown.body.offers : NO_OFFERS), [shown]);
  const doneBody = state.kind === "done" ? state.body : null;
  const airportCode = values.airport.toUpperCase();
  const airportInfo = useMemo(() => {
    const a = airports.find((x) => x.code === airportCode);
    return a ? { code: a.code, latitude: a.latitude, longitude: a.longitude } : null;
  }, [airports, airportCode]);
  const pins = useMemo<ParkStayPin[]>(
    () =>
      offers.map((c) => ({
        key: c.hotelKey,
        name: c.name,
        latitude: c.lot.latitude,
        longitude: c.lot.longitude,
        label: formatCents(c.room.price.headlineTotalCents),
      })),
    [offers]
  );

  const banner =
    state.kind === "done"
      ? focusBanner({ focus, airport: state.body.airport.code, offerKeys: offers.map((o) => o.hotelKey), partial: state.body.partial, hotels })
      : null;
  const focusShown = focus !== null && offers.some((o) => o.hotelKey === focus);

  // Scroll the focus hotel into view once per finished search.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusShown || !focus) return;
    const marker = `${query}|${attempt}|${focus}`;
    if (scrolledFor.current === marker) return;
    scrolledFor.current = marker;
    document.getElementById(cardElementId(focus))?.scrollIntoView({ block: "center" });
  }, [focusShown, focus, query, attempt]);

  const hasMapResults = state.kind === "done" && offers.length > 0;
  // A mobile map view only makes sense with results; otherwise the list (and
  // its retry / empty panel) stays visible, never a blank screen.
  const showMobileMap = mobileView === "map" && hasMapResults;

  function selectFromMap(key: string) {
    setHoveredKey(key);
    const el = document.getElementById(showMobileMap ? mapCardElementId(key) : cardElementId(key));
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }

  function onCarouselScroll() {
    const el = carouselRef.current;
    if (!el || offers.length === 0) return;
    const cardWidth = el.offsetWidth * 0.88 + 12; // 88vw card + gap, as on /search
    const index = Math.min(Math.max(Math.round(el.scrollLeft / cardWidth), 0), offers.length - 1);
    setHoveredKey(offers[index].hotelKey);
  }

  // The map: pins (or the airport alone) once there is an answer or nothing
  // to search yet; blank while loading and on an error (the list has the retry).
  const mapReady = state.kind === "done" || state.kind === "idle";
  const renderMap = (showControls: boolean) =>
    mapReady ? (
      <MapErrorBoundary>
        <LazyParkStayMap pins={pins} airport={airportInfo} hoveredKey={hoveredKey} onHover={setHoveredKey} onSelect={selectFromMap} showControls={showControls} />
      </MapErrorBoundary>
    ) : (
      <MapPlaceholder />
    );

  const currentHref = `/park-stay?${parkStayPageQuery(values, focus)}`;
  const content = doneBody ? listContent(doneBody) : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="px-4 pt-2 sm:px-6 lg:px-8">
        <PreviewBanner />
      </div>
      <ParkStayHeader
        key={`${query}|${focus ?? ""}`}
        airports={airports}
        values={values}
        focus={focus}
        parking={parkingOnlySide(values, todayInZone(airportTimeZone(airports, values.airport), new Date()))}
        currentHref={currentHref}
      />

      <div className="relative flex flex-1 overflow-hidden">
        <section aria-label="Hotels" className={`no-scrollbar h-full w-full overflow-y-auto bg-gray-50 lg:w-2/5 ${showMobileMap ? "hidden lg:block" : ""}`}>
          {/* The parking list's sticky header (SearchResultsList, classes copied; one ranking, so no sort). */}
          {state.kind === "done" && (
            <div className="sticky top-0 z-20 bg-gray-50 px-4 sm:px-6 py-4 border-b border-gray-200 shadow-sm backdrop-blur-sm bg-opacity-95">
              <div className="flex items-baseline gap-2">
                <h2 className="text-lg font-bold text-gray-900 leading-none">Park &amp; Stay at {state.body.airport.code}</h2>
                <span className="text-sm font-medium text-gray-400">
                  {offers.length} {offers.length === 1 ? "Result" : "Results"}
                </span>
              </div>
            </div>
          )}
          <div className="p-4 sm:p-6 space-y-4 pb-20">
          {state.kind === "idle" && (
            <Panel title="Find a hotel night with parking">
              <p className="text-gray-600">Choose your airport, hotel check-in date and parking return date, then when you&apos;ll arrive at the hotel, your return time and the number of guests.</p>
            </Panel>
          )}
          {state.kind === "loading" && (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-brand-orange" />
                <p className="text-gray-500">Checking hotels and their parking…</p>
              </div>
            </div>
          )}
          {state.kind === "error" && (
            <Panel title={state.retry ? "We couldn't load hotels right now" : "Check your search"}>
              <p className="text-gray-600">{state.message}</p>
              {state.retry && <RetryButton onClick={retry} />}
            </Panel>
          )}
          {state.kind === "done" && (
            <>
              <p className="text-sm text-muted-foreground">
                Hotel check-in {formatIsoDay(state.body.search.night)}, check-out {formatIsoDay(state.body.search.departureDate)}. Parking from{" "}
                {state.body.search.arrivalTime} on {formatIsoDay(state.body.search.night)} until {state.body.search.returnTime} on{" "}
                {formatIsoDay(state.body.search.returnDate)}.
              </p>
              {banner && (
                <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {banner}
                </p>
              )}
              {state.body.partial && offers.length > 0 && <p className="rounded-md bg-muted px-3 py-2 text-sm">Some hotels couldn&apos;t be checked right now.</p>}
              {content?.kind === "retry" ? (
                // Partial AND empty is "we don't know", never "none available" (M2).
                <Panel>
                  <p>We couldn&apos;t check some hotels right now.</p>
                  <RetryButton onClick={retry} />
                </Panel>
              ) : content?.kind === "empty" ? (
                <Panel>
                  <p>{content.copy}</p>
                </Panel>
              ) : (
                offers.map((card, i) => (
                  <ParkStayResultCard
                    key={card.hotelKey}
                    card={card}
                    href={hotelHref(state.body.airport.code, card, query)}
                    airport={{ code: state.body.airport.code, point: airportInfo }}
                    returnDate={state.body.search.returnDate}
                    isHovered={hoveredKey === card.hotelKey}
                    isFocused={focus === card.hotelKey}
                    isFirst={i === 0}
                    onHover={setHoveredKey}
                  />
                ))
              )}
            </>
          )}
          </div>
        </section>

        {/* Mobile: full-screen map with a snap carousel */}
        {showMobileMap && state.kind === "done" && (
          <div className="relative h-full w-full lg:hidden">
            {renderMap(false)}
            <div className="absolute bottom-0 left-0 right-0 pb-20 pt-2">
              <div ref={carouselRef} onScroll={onCarouselScroll} className="no-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto px-4">
                {offers.map((card) => (
                  <ParkStayMapCard key={card.hotelKey} card={card} href={hotelHref(state.body.airport.code, card, query)} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Desktop: the map beside the list (lg+ only) */}
        <div className="relative hidden h-full w-3/5 border-l border-gray-200 bg-gray-100 lg:block">{isDesktop && renderMap(true)}</div>
      </div>

      {/* Mobile: list ↔ map */}
      {hasMapResults && (
        <button
          type="button"
          onClick={() => setMobileView(mobileView === "list" ? "map" : "list")}
          className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-navy px-5 py-3 text-sm font-semibold text-white shadow-lg transition-transform active:scale-95 lg:hidden"
        >
          {showMobileMap ? (
            <>
              <List size={18} aria-hidden="true" />
              List
            </>
          ) : (
            <>
              <MapIcon size={18} aria-hidden="true" />
              Map
            </>
          )}
        </button>
      )}
    </div>
  );
}
