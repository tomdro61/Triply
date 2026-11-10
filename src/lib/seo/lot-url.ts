import { notFound, permanentRedirect } from "next/navigation";
import { getAirportByCode, getAirportBySlug, productionAirports } from "@/config/airports";
import { lotSlugStatus } from "@/lib/reslab/get-lot";
import type { LinkParam } from "@/lib/utils/link-date";

/**
 * The lot page's status decision, made BEFORE its Suspense boundary: a
 * notFound() inside the streamed body is sent after a 200, so a dead lot URL
 * was a soft 404 (200, "Parking Not Found", noindex — 66 URLs in Search
 * Console's noindex report, 10 Nov 2026).
 *
 * Lot slugs once carried the airport code (`snap-parking-ewr`, now
 * `snap-parking`), and Google still crawls those from an old sitemap. When the
 * slug names no lot but its code-less form is a live lot, 308 there — under
 * the airport the suffix names (`/new-york-lga/…/bolt-parking-jfk` →
 * `/new-york-jfk/…/bolt-parking`), query kept. When nothing matches, a real
 * 404. When the lists cannot tell ("unknown"), return and let the page render
 * as before — never a 404 or redirect on a guess.
 */
export async function resolveLotUrl(
  airportSlug: string,
  lotSlug: string,
  query: Record<string, LinkParam>,
): Promise<void> {
  const airport = getAirportBySlug(airportSlug);
  if (!airport) notFound();
  if ((await lotSlugStatus(lotSlug, airport.code)) !== "missing") return;

  const suffix = /^(.+)-([a-z]{3})$/.exec(lotSlug);
  const suffixAirport = suffix ? getAirportByCode(suffix[2]) : undefined;
  if (suffix && suffixAirport && productionAirports.includes(suffixAirport)) {
    if ((await lotSlugStatus(suffix[1], suffixAirport.code)) === "exists") {
      permanentRedirect(`/${suffixAirport.slug}/airport-parking/${suffix[1]}${queryString(query)}`);
    }
  }
  notFound();
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
