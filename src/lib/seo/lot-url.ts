import { notFound, permanentRedirect } from "next/navigation";
import { getAirportByCode, getAirportBySlug, productionAirports, type Airport } from "@/config/airports";
import { lotIdLookup, lotSlugLookup, type LotLookup } from "@/lib/reslab/get-lot";
import type { ReslabLocation } from "@/lib/reslab/client";
import { isExemptFromOwnership, locationBelongsToAirport } from "@/lib/search/airport-ownership";
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
 *   live slug (any airport)         → renders. A lot another airport owns
 *                                      keeps rendering here: search's
 *                                      own-airport fallback links sold-out
 *                                      airports' cards this way, and the
 *                                      canonical already points Google at the
 *                                      owner (in <head> for Googlebot now).
 *   numeric id (`466`, `reslab-466`) → 308 to the lot's slug URL under the
 *                                      airport its canonical names; real 404
 *                                      when the list holds it as hidden; an id
 *                                      the list lacks renders as before
 *                                      (getLotById reads it from ResLab)
 *   old slug with an airport-code   → 308 to the live lot of that name within
 *     suffix (`snap-parking-ewr`)      search range of that airport, under the
 *                                      airport its canonical names; 404 when
 *                                      the only same-name lot is far away
 *                                      (`park-for-u-yyz` must not land on the
 *                                      JFK lot), whatever the kill switch says
 *   old slug with a cruise-port     → the same, for the URL's own airport
 *     suffix (`…-portmiami`)
 *   nothing matches                 → real 404
 *   any lookup "unknown"            → renders as before; never a 404 or a
 *     (thin list, failed read,        308 on a guess
 *     too slow, threw)
 *
 * Every 308 lands on the URL the page's canonical names (canonicalOwner
 * mirrors canonicalAirportFor in lot-schema.ts), so there is never a hop to a
 * non-canonical URL, nor a chain when the own-airport kill switch flips.
 */
export async function resolveLotUrl(
  airportSlug: string,
  lotSlug: string,
  query: Record<string, LinkParam>,
): Promise<void> {
  const airport = getAirportBySlug(airportSlug);
  if (!airport) notFound();
  const qs = queryString(query);
  // One log line per 404 / 308, with the rule that decided it, so a misfiring
  // rule shows in the Vercel logs (event "lot_url_decision"), not weeks later
  // in Search Console.
  const gone = (reason: string): never => {
    console.info(JSON.stringify({ event: "lot_url_decision", airport: airport.code, slug: lotSlug, decision: "404", reason }));
    notFound();
  };
  const moved = (target: string, reason: string): never => {
    console.info(JSON.stringify({ event: "lot_url_decision", airport: airport.code, slug: lotSlug, decision: "308", reason, target }));
    permanentRedirect(`${target}${qs}`);
  };
  const lookup = (what: string, read: () => Promise<LotLookup>) => withDeadline(read(), airport.code, lotSlug, what);

  if (/^(reslab-)?\d+$/.test(lotSlug)) {
    const byId = await lookup("id", () => lotIdLookup(lotSlug));
    if (byId.status === "unknown") return;
    if (byId.status === "missing") return gone("id_hidden");
    const loc = byId.reslab[0];
    return moved(`/${canonicalOwner(loc, airport).slug}/airport-parking/${generateSlug(loc.name)}`, "id");
  }

  const here = await lookup("slug", () => lotSlugLookup(lotSlug, airport.code));
  if (here.status === "unknown") return;
  // A live lot renders, wherever it is owned (see the table above).
  if (here.status === "exists") return;

  for (const { slug, at } of oldSlugTwins(lotSlug, airport)) {
    const twin = await lookup(`twin ${slug}@${at.code}`, () => lotSlugLookup(slug, at.code));
    // Can't tell whether the live twin exists: render as before, no 404 on a guess.
    if (twin.status === "unknown") return;
    if (twin.status !== "exists") continue;
    // A direct lot of that name at that airport.
    if (twin.reslab.length === 0) return moved(`/${at.slug}/airport-parking/${slug}`, "twin_direct");
    // The same-name lot nearest the named airport, when it is within search
    // range (an old `-lga` slug for a lot JFK now owns lands on JFK's page).
    // A same-name lot far away is not this one: park-for-u-yyz must never 308
    // to the JFK lot, with or without the own-airport kill switch, and an
    // exempt airport (POE claims every lot) gets no pass either.
    const near = nearest(twin.reslab, at);
    if (distanceKm(near, at) <= AIRPORT_SEARCH_RADIUS_KM) {
      return moved(`/${canonicalOwner(near, at).slug}/airport-parking/${slug}`, "twin");
    }
    // A thin list may be missing a nearer one: render as before.
    if (twin.incomplete) return;
  }
  return gone("missing");
}

/**
 * The pre-check runs before the page's first byte (before its Suspense
 * spinner), so it gets its own deadline: a slow list read (a cold instance
 * whose snapshot read misses and falls back to the sweep) renders the page as
 * before instead of holding a blank tab, or a 504, until it settles. The read
 * keeps running; the page body awaits the same single-flight list. A lookup
 * that throws is "unknown" too: the body hits the same error and shows it.
 */
const PRECHECK_DEADLINE_MS = 3000;

async function withDeadline(read: Promise<LotLookup>, airport: string, slug: string, what: string): Promise<LotLookup> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<LotLookup>((resolve) => {
    timer = setTimeout(() => {
      console.warn(JSON.stringify({ event: "lot_url_precheck_timeout", airport, slug, what, ms: PRECHECK_DEADLINE_MS }));
      resolve({ status: "unknown" });
    }, PRECHECK_DEADLINE_MS);
  });
  try {
    return await Promise.race([
      read.catch((error: unknown) => {
        console.warn(`[lot-page] pre-check ${what} threw for ${airport}/${slug}:`, error);
        return { status: "unknown" } as const;
      }),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
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

/**
 * The airport whose URL the lot page's canonical names when this lot renders
 * under `airport`: canonicalAirportFor (lot-schema.ts) for a ResLab location.
 * This airport if it owns the lot, else the nearest-wins owner among airports
 * the rule covers. Exempt airports (cruise ports, single-location, test) say
 * yes to every lot, so they never win the search (POE sorts mid-list and
 * would take every later airport's lots). Like the canonical, it ignores the
 * own-airport kill switch, so a 308 never lands on a non-canonical URL.
 */
function canonicalOwner(loc: ReslabLocation, airport: Airport): Airport {
  if (locationBelongsToAirport(loc, airport)) return airport;
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
