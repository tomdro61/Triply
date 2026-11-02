/**
 * The homepage Park & Stay section's hotel cards (CX plan §5): built only
 * from the access response — no supplier call, no price, no rating. One
 * hotel per airport first (in the response's airport order: JFK, LGA, EWR),
 * then the next hotels in map order, up to four. The shuttle line is the
 * hotel's own `shuttle` field, word for word (never "free").
 */

import type { ParkStayAccess } from "@/lib/hotels/access";

export const HOME_CARD_LIMIT = 4;

export interface HomeCard {
  key: string;
  airport: string;
  name: string;
  /** Null renders the placeholder. */
  photoUrl: string | null;
  shuttle: string;
  /** /park-stay for the airport with the hotel highlighted; that page fills the starting dates (withSearchDefaults). */
  href: string;
}

export function homeCards(access: ParkStayAccess, limit: number = HOME_CARD_LIMIT): HomeCard[] {
  const open = access.airports.map((a) => a.code.toUpperCase());
  const hotels = access.hotels.filter((h) => open.includes(h.airport.toUpperCase()));
  const picked: typeof hotels = [];
  for (const code of open) {
    const first = hotels.find((h) => h.airport.toUpperCase() === code);
    if (first && picked.length < limit) picked.push(first);
  }
  for (const h of hotels) {
    if (picked.length >= limit) break;
    if (!picked.includes(h)) picked.push(h);
  }
  return picked.map((h) => {
    const airport = h.airport.toUpperCase();
    return {
      key: h.key,
      airport,
      name: h.name,
      photoUrl: h.photoUrl,
      shuttle: h.shuttle,
      href: `/park-stay?${new URLSearchParams({ airport, focus: h.key }).toString()}`,
    };
  });
}
