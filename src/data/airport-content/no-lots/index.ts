import { AirportContent } from "../types";

/**
 * Guides for airport pages that list no bookable lots (Vin, 10 Nov 2026:
 * index every airport page, and make the empty ones worth landing on).
 *
 * Shown ONLY while the page has nothing to book, in place of the lot list.
 * The copy must stay true while we sell nothing there: the airport's own
 * parking, transit and nearby airports, each figure from a source named in
 * the file and dated. Never a Triply lot, price or "book now" claim.
 */
const noLotsModules: Record<string, () => Promise<{ default: AirportContent }>> = {
  DAL: () => import("./dal"),
  RSW: () => import("./rsw"),
  YOW: () => import("./yow"),
  YUL: () => import("./yul"),
  YYC: () => import("./yyc"),
  YYZ: () => import("./yyz"),
};

export async function getNoLotsAirportContent(airportCode: string): Promise<AirportContent | null> {
  const loader = noLotsModules[airportCode.toUpperCase()];
  if (!loader) return null;
  return (await loader()).default;
}

export const NO_LOTS_GUIDE_CODES: readonly string[] = Object.keys(noLotsModules);
