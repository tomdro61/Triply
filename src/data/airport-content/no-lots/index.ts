import { AirportContent } from "../types";
import type { FAQItem, SEOSection } from "@/lib/airport-page/content";
import { getAirportByCode } from "@/config/airports";

/**
 * Guides for airport pages that list no bookable lots (Vin, 10 Nov 2026:
 * index every airport page, and make the empty ones worth landing on).
 *
 * Shown ONLY while the page has nothing to book, in place of the lot list.
 * The copy must stay true while we sell nothing there: the airport's own
 * parking, transit and nearby airports, each figure from a source named in
 * the file and dated. Never a Triply lot, price or "book now" claim, and
 * never a "cheapest" ranking (we can't see every lot near the airport).
 *
 * Anything true only until a known date carries `showUntil` (the last day it
 * shows, airport-local YYYY-MM-DD): it drops off the page, its FAQ markup and
 * the meta on the next hourly revalidation after that day. A figure that
 * changes on a known date is written so it reads true on both sides of it
 * ("until 31 December 2026 … from 1 January 2027 …").
 */
type Dated<T> = T & { showUntil?: string };

export interface NoLotsGuide extends Omit<AirportContent, "sections" | "faqs"> {
  sections: Dated<SEOSection>[];
  faqs: Dated<FAQItem>[];
}

const noLotsModules: Record<string, () => Promise<{ default: NoLotsGuide }>> = {
  DAL: () => import("./dal"),
  RSW: () => import("./rsw"),
  YOW: () => import("./yow"),
  YUL: () => import("./yul"),
  YYC: () => import("./yyc"),
  YYZ: () => import("./yyz"),
};

/** Today in the airport's own timezone, as YYYY-MM-DD. */
function airportToday(code: string, now: Date): string {
  const timeZone = getAirportByCode(code)?.timezone ?? "America/New_York";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export async function getNoLotsAirportContent(airportCode: string, now: Date = new Date()): Promise<AirportContent | null> {
  const code = airportCode.toUpperCase();
  const loader = noLotsModules[code];
  if (!loader) return null;
  const guide = (await loader()).default;
  const today = airportToday(code, now);
  const current = <T,>(item: Dated<T>) => !item.showUntil || today <= item.showUntil;
  return {
    ...guide,
    sections: guide.sections.filter(current).map(withoutDate),
    faqs: guide.faqs.filter(current).map(withoutDate),
  };
}

function withoutDate<T>(item: Dated<T>): T {
  const copy = { ...item };
  delete copy.showUntil;
  return copy;
}

export const NO_LOTS_GUIDE_CODES: readonly string[] = Object.keys(noLotsModules);
