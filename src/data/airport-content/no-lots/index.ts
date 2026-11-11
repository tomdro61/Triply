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
 * shows, airport-local YYYY-MM-DD): it drops off the page and its FAQ markup
 * on the next successful hourly revalidation after that day (a failed one
 * keeps the last good page). The meta description has no date gate, so it
 * never names dated content. A figure that
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

/** Today in the airport's own timezone, as YYYY-MM-DD (built from parts, not a locale's format). */
function airportToday(code: string, now: Date): string {
  const timeZone = getAirportByCode(code)?.timezone ?? "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The guide as written, showUntil included (the tests check every date is a real YYYY-MM-DD). */
export async function loadRawNoLotsGuide(airportCode: string): Promise<NoLotsGuide | null> {
  const loader = noLotsModules[airportCode.toUpperCase()];
  return loader ? (await loader()).default : null;
}

export async function getNoLotsAirportContent(airportCode: string, now: Date = new Date()): Promise<AirportContent | null> {
  const code = airportCode.toUpperCase();
  const guide = await loadRawNoLotsGuide(code);
  if (!guide) return null;
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
