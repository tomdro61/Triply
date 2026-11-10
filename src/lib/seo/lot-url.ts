import { notFound, permanentRedirect } from "next/navigation";
import { getAirportByCode, getAirportBySlug, productionAirports, type Airport } from "@/config/airports";
import { lotIdLookup, lotSlugLookup } from "@/lib/reslab/get-lot";
import type { ReslabLocation } from "@/lib/reslab/client";
import { isExemptFromOwnership, isOwnAirportFilterEnabled, locationBelongsToAirport } from "@/lib/search/airport-ownership";
import { AIRPORT_SEARCH_RADIUS_KM } from "@/lib/reslab/search";
import { calculateDistance } from "@/lib/utils/geo";
import { generateSlug } from "@/lib/utils/slug";
import type { LinkParam } from "@/lib/utils/link-date";

/**
 * The lot page's status decision, made BEFORE its Suspense boundary: a
 * notFound() inside the streamed body is sent after a 200, so a dead lot URL
 * was a soft 404 (200, "Parking Not Found", noindex — 66 URLs in Search
 * Console's noindex report, 137 more in "crawled, not indexed", 10 Nov 2026).
 *
 *   live slug, owned here           → renders
 *   live slug, no same-name lot     → 308 to the owning airport (what the
 *     owned here                       canonical already says; a thin list
 *                                      renders instead)
 *   numeric id (`466`, `reslab-466`) → 308 to the lot's slug URL; real 404
 *                                      when the id is gone
 *   old slug with an airport-code   → 308 to the live lot of that name at
 *     suffix (`snap-parking-ewr`)      that airport, or at the neighbour that
 *                                      now owns it when it is within search
 *                                      range; 404 when the only same-name lot
 *                                      is far away (`park-for-u-yyz` must not
 *                                      land on the JFK lot)
 *   old slug with a cruise-port     → 308 to the live lot of that name here
 *     suffix (`…-portmiami`)
 *   nothing matches                 → real 404
 *   any lookup "unknown"            → renders as before; never a 404 or a
 *     (thin list, failed read)        308 on a guess
 */
export async function resolveLotUrl(
  airportSlug: string,
  lotSlug: string,
  query: Record<string, LinkParam>,
): Promise<void> {
  const airport = getAirportBySlug(airportSlug);
  if (!airport) notFound();
  const qs = queryString(query);

  if (/^(reslab-)?\d+$/.test(lotSlug)) {
    const byId = await lotIdLookup(lotSlug);
    if (byId.status === "unknown") return;
    if (byId.status === "missing") notFound();
    const loc = byId.reslab[0];
    permanentRedirect(`/${ownerOf(loc, airport).slug}/airport-parking/${generateSlug(loc.name)}${qs}`);
  }

  const here = await lotSlugLookup(lotSlug, airport.code);
  if (here.status === "unknown") return;
  if (here.status === "exists") {
    // A same-name lot this airport owns (the one the sitemap lists), a direct
    // lot, or a thin list that may hide it: render. Otherwise the lot is
    // another airport's — 308 there, as the canonical already says.
    if (here.reslab.length === 0 || here.incomplete || here.reslab.some((l) => belongs(l, airport))) return;
    const owner = ownerOf(nearest(here.reslab, airport), airport);
    if (owner.code !== airport.code) permanentRedirect(`/${owner.slug}/airport-parking/${lotSlug}${qs}`);
    return;
  }

  for (const { slug, at } of oldSlugTwins(lotSlug, airport)) {
    const twin = await lotSlugLookup(slug, at.code);
    // Can't tell whether the live twin exists: render as before, no 404 on a guess.
    if (twin.status === "unknown") return;
    if (twin.status !== "exists") continue;
    if (twin.reslab.length === 0 || twin.reslab.some((l) => belongs(l, at))) {
      permanentRedirect(`/${at.slug}/airport-parking/${slug}${qs}`);
    }
    if (twin.incomplete) return;
    // The lot now belongs to a neighbour (an old `-lga` slug for a JFK lot):
    // follow it when it is within search range of the named airport. A
    // same-name lot far away (park-for-u-yyz vs the JFK lot) is not this one.
    const near = nearest(twin.reslab, at);
    if (distanceKm(near, at) <= AIRPORT_SEARCH_RADIUS_KM) {
      permanentRedirect(`/${ownerOf(near, at).slug}/airport-parking/${slug}${qs}`);
    }
  }
  notFound();
}

/** Suffixes old lot slugs carried that are not airport codes. */
const PORT_SUFFIX = /^(.+)-(portmiami|port-everglades|port-jacksonville|port-canaveral|port-of-san-diego)$/;

/** The code-less slug an old URL most likely meant, and the airport it belongs under. */
function oldSlugTwins(lotSlug: string, airport: Airport): { slug: string; at: Airport }[] {
  const out: { slug: string; at: Airport }[] = [];
  const code = /^(.+)-([a-z]{3})$/.exec(lotSlug);
  const codeAirport = code ? getAirportByCode(code[2]) : undefined;
  if (code && codeAirport && productionAirports.includes(codeAirport)) out.push({ slug: code[1], at: codeAirport });
  const port = PORT_SUFFIX.exec(lotSlug);
  if (port) out.push({ slug: port[1], at: airport });
  return out;
}

/** With the own-airport filter off (its kill switch), every airport may list the lot: no ownership redirects. */
function belongs(loc: ReslabLocation, airport: Airport): boolean {
  return !isOwnAirportFilterEnabled() || locationBelongsToAirport(loc, airport);
}

/**
 * The airport that owns this lot: this one if it does, else the nearest-wins
 * owner among airports the rule covers. Exempt airports (cruise ports,
 * single-location, test) say yes to every lot, so they never win the search
 * (POE sorts mid-list and would take every later airport's lots).
 */
function ownerOf(loc: ReslabLocation, airport: Airport): Airport {
  if (belongs(loc, airport)) return airport;
  return productionAirports.find((a) => !isExemptFromOwnership(a) && locationBelongsToAirport(loc, a)) ?? airport;
}

function distanceKm(loc: ReslabLocation, airport: Airport): number {
  const mi = calculateDistance(airport.latitude, airport.longitude, parseFloat(loc.latitude), parseFloat(loc.longitude), false);
  return Number.isNaN(mi) ? Infinity : mi * 1.609344;
}

/** findLotBySlug's tie-break: the same-name lot nearest the URL's airport. */
function nearest(locs: readonly ReslabLocation[], airport: Airport): ReslabLocation {
  const dist = (l: ReslabLocation) => {
    const d = calculateDistance(airport.latitude, airport.longitude, parseFloat(l.latitude), parseFloat(l.longitude), false);
    return Number.isNaN(d) ? Infinity : d;
  };
  return locs.reduce((best, l) => (dist(l) < dist(best) ? l : best), locs[0]);
}

function queryString(query: Record<string, LinkParam>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const v of values) q.append(key, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
