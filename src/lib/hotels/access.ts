/**
 * What /api/park-stay/access tells an admin's browser (CX plan v2 §1, "Lock
 * 2"): which airports and hotels Park & Stay is open for, with the
 * pre-search display facts. Pure — the route resolves the flag, the viewer
 * and the ResLab account, then calls this. No supplier call can start here:
 * everything comes from the committed map.
 *
 * `reslabLotId` is the id under THIS deployment's ResLab account (the
 * fingerprint table in reslab-account.ts). An unknown account, or a null id
 * under it, gives null — never another account's id (staging shows no
 * parking-card badges, which is correct).
 */

import { HOTEL_LOTS, type HotelLotEntry, type ReslabAccount } from "./hotel-lots";
import { reslabIdFor } from "./reslab-account";
import { safePhotoUrl } from "./photo-hosts";

export interface ParkStayAccessAirport {
  code: string;
  name: string;
}

export interface ParkStayAccessHotel {
  key: string;
  airport: string;
  reslabLotId: number | null;
  /** The map's LiteAPI name (the name the results and hotel pages fall back to). */
  name: string;
  /** Null renders the placeholder. */
  photoUrl: string | null;
  shuttle: string;
}

export interface ParkStayAccess {
  airports: ParkStayAccessAirport[];
  hotels: ParkStayAccessHotel[];
}

/** Enabled hotels at the given (already open) airports, in map order. */
export function buildParkStayAccess(
  airports: readonly ParkStayAccessAirport[],
  account: ReslabAccount | null,
  lots: readonly HotelLotEntry[] = HOTEL_LOTS
): ParkStayAccess {
  const open = new Set(airports.map((a) => a.code.toUpperCase()));
  return {
    airports: airports.map((a) => ({ code: a.code, name: a.name })),
    hotels: lots
      .filter((e) => e.enabled && open.has(e.airport))
      .map((e) => ({
        key: e.key,
        airport: e.airport,
        reslabLotId: account ? reslabIdFor(e, account) : null,
        name: e.liteapi.name,
        // Belt and braces: the map's URLs are pinned by a test, but nothing
        // reaches an <img> without passing the allowlist.
        photoUrl: safePhotoUrl(e.display.photoUrl).url,
        shuttle: e.display.shuttle,
      })),
  };
}
