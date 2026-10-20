/**
 * The hotel ↔ lot map (Park & Stay plan v3 §3, PRD M1): each ResLab hotel
 * lot and the LiteAPI hotel it belongs to. A committed file, not a table —
 * every change goes through a PR and review, because a wrong row puts a room
 * where the car isn't.
 *
 * Dependency-free on purpose (no imports at all): the read-only drift script
 * `scripts/park-stay/check-hotel-lots.mjs` imports this file directly with
 * Node's type stripping, and `__tests__/hotel-lots.test.ts` validates it.
 *
 * Seed: `reslab-liteapi-match.json` (18 Oct 2026; matcher rated all ten
 * "strong" — not proof, it also rated three wrong pairs strong elsewhere).
 * ResLab fields: the production location snapshot of 18 Oct. LiteAPI fields:
 * the sandbox `/hotels/rates` `hotels[]` block of 19 Oct (V2,
 * `includeHotelData: true`).
 *
 * `check` records the M1 hand check. The 19 Oct entries are a DATA
 * cross-check by the build agent (address, phone, name, coordinates, lot
 * type, shuttle, due-at-lot, cancellation policy, all from the files above).
 * The plan's map step (open both points, confirm the lot is the hotel's own
 * garage) still needs a person before Phase B — each row's evidence says so.
 *
 * `reslab.ids.staging` is null everywhere until V1 reads the staging
 * account's location list (plan §9.3); a null id fails closed for that
 * account, it is never guessed.
 *
 * `display` (Park & Stay CX plan v2 §5, 20 Oct 2026) is what an admin sees
 * before any price is asked — served only through /api/park-stay/access:
 *   - `photoUrl`: hand-copied from the 19 Oct sandbox `/hotels/rates`
 *     `hotels[].main_photo` (the V2b run, matched on `liteapi.hotelId`).
 *     Sandbox URLs can expire: a dead image shows the card's placeholder,
 *     and check-hotel-lots.mjs could re-check them later. Must stay on HOTEL_PHOTO_HOSTS
 *     (photo-hosts.ts — the test pins it).
 *   - `shuttle`: one short line restating the shuttle facts in `evidence`
 *     (ResLab's shuttle fields, 18 Oct snapshot). Never "free" — no source
 *     says so. Unknown hours say so ("hours shown before you book").
 */

export type ReslabAccount = "production" | "staging";
export type ParkStayAirportCode = "JFK" | "LGA" | "EWR";

export interface HotelLotEntry {
  /** Unique URL slug, e.g. "doubletree-jfk". */
  key: string;
  airport: ParkStayAirportCode;
  enabled: boolean;
  /** Set exactly when `enabled` is false. */
  disabledReason: string | null;
  reslab: {
    /** Location id per ResLab account — the two accounts use different ids (§9.3). */
    ids: Record<ReslabAccount, number | null>;
    /** ResLab's own `name`, verbatim; the runtime guard compares it normalised. */
    name: string;
    latitude: number;
    longitude: number;
  };
  liteapi: {
    /** Authoritative (hand-checked; LiteAPI ids are stable). */
    hotelId: string;
    name: string;
    latitude: number;
    longitude: number;
  };
  /** The M1 hand check: who, when (YYYY-MM-DD), and what was compared. */
  check: { by: string; on: string; evidence: string };
  /** Pre-search display facts (see the header): a photo (null = the placeholder) and the shuttle line. */
  display: { photoUrl: string | null; shuttle: string };
}

const DATA_CHECK_BY = "Claude (build agent) — data cross-check, map step pending a person";
const DATA_CHECK_ON = "2026-10-19";
const MAP_STEP_PENDING =
  "PENDING before Phase B: open both points on a map and confirm the lot is the hotel's own (plan §3.3 steps 2–3).";

export const HOTEL_LOTS: readonly HotelLotEntry[] = [
  {
    key: "doubletree-jfk",
    airport: "JFK",
    enabled: true,
    disabledReason: null,
    reslab: { ids: { production: 132, staging: null }, name: "DoubleTree by Hilton", latitude: 40.6673095, longitude: -73.7984598 },
    liteapi: { hotelId: "lp27fe6", name: "DoubleTree by Hilton New York JFK Airport", latitude: 40.667623, longitude: -73.798414 },
    check: {
      by: DATA_CHECK_BY,
      on: DATA_CHECK_ON,
      evidence:
        "Same street address (135-30 140th Street, Jamaica); points 35 m apart; lot type parking_room, valet, 24/7 shuttle every 30 min, nothing due at lot, 100% refund. Formerly a Radisson — re-check the name on drift. " +
        MAP_STEP_PENDING,
    },
    display: { photoUrl: "https://static.cupid.travel/hotels/614117928.jpg", shuttle: "Shuttle every 30 min, 24/7" },
  },
  {
    key: "hampton-inn-jfk",
    airport: "JFK",
    enabled: true,
    disabledReason: null,
    reslab: { ids: { production: 304, staging: null }, name: "Hampton Inn John F. Kennedy Airport", latitude: 40.667479, longitude: -73.7949621 },
    liteapi: { hotelId: "lp3034d", name: "Hampton Inn NY-JFK", latitude: 40.667607, longitude: -73.79582 },
    check: {
      by: DATA_CHECK_BY,
      on: DATA_CHECK_ON,
      evidence:
        "Same address (144-10 135th Avenue, Jamaica); points 74 m apart; names overlap only on 'Hampton Inn'/'JFK'. parking_room, 24/7 shuttle, nothing due at lot, 100% refund, minimum_booking_days 2. " +
        MAP_STEP_PENDING,
    },
    display: { photoUrl: "https://static.cupid.travel/hotels/484877642.jpg", shuttle: "Shuttle 24/7" },
  },
  {
    key: "hyatt-place-flushing-lga",
    airport: "LGA",
    enabled: true,
    disabledReason: null,
    reslab: { ids: { production: 159, staging: null }, name: "Hyatt Place Flushing - LAZ Parking", latitude: 40.7589732, longitude: -73.8323536 },
    liteapi: { hotelId: "lp6d0b4", name: "Hyatt Place Flushing/LaGuardia Airport", latitude: 40.759464, longitude: -73.83297 },
    check: {
      by: DATA_CHECK_BY,
      on: DATA_CHECK_ON,
      evidence:
        "DIFFERENT STREETS: lot 133-59 Roosevelt Ave, hotel 133-42 39th Ave; points 75 m apart. Not yet confirmed that the LAZ garage is the hotel's own. Shuttle 7 AM – 10 PM only; front_desk_hours empty. parking_room, nothing due at lot, 100% refund. " +
        MAP_STEP_PENDING,
    },
    display: { photoUrl: "https://static.cupid.travel/hotels/ex_5b16ef7f_z.jpg", shuttle: "Shuttle 7 AM – 10 PM" },
  },
  {
    key: "laguardia-marriott",
    airport: "LGA",
    enabled: true,
    disabledReason: null,
    reslab: { ids: { production: 454, staging: null }, name: "New York LaGuardia Marriott Airport Hotel", latitude: 40.768853, longitude: -73.8677325 },
    liteapi: { hotelId: "lp19fcb", name: "New York LaGuardia Airport Marriott", latitude: 40.768755, longitude: -73.867346 },
    check: {
      by: DATA_CHECK_BY,
      on: DATA_CHECK_ON,
      evidence:
        "Same address (102-05 Ditmars Blvd, East Elmhurst); points 34 m apart; parking_room, 24/7 shuttle every 15 min, nothing due at lot, 100% refund. " +
        MAP_STEP_PENDING,
    },
    display: { photoUrl: "https://static.cupid.travel/hotels/430823651.jpg", shuttle: "Shuttle every 15 min, 24/7" },
  },
  {
    key: "red-carpet-inn-ewr",
    airport: "EWR",
    enabled: false,
    disabledReason: "D2 (Tom, 19 Oct 2026): no airport shuttle ('Uber and Lyft'), in Irvington — excluded at launch.",
    reslab: { ids: { production: 184, staging: null }, name: "Red Carpet Inn", latitude: 40.7231822, longitude: -74.2316072 },
    liteapi: { hotelId: "lp3f83e", name: "Red Carpet Inn Newark - Irvington NJ", latitude: 40.723205, longitude: -74.231718 },
    check: {
      by: DATA_CHECK_BY,
      on: DATA_CHECK_ON,
      evidence: "Same address (100 Union Avenue, Irvington); points 10 m apart; shuttle_available 0; minimum_booking_days 1. Disabled per D2.",
    },
    display: { photoUrl: "https://static.cupid.travel/hotels/182049147.jpg", shuttle: "No airport shuttle" },
  },
  {
    key: "renaissance-newark-airport",
    airport: "EWR",
    enabled: true,
    disabledReason: null,
    reslab: { ids: { production: 259, staging: null }, name: "Renaissance Newark Airport Hotel", latitude: 40.6835742, longitude: -74.1941777 },
    liteapi: { hotelId: "lp307de", name: "Renaissance Newark Airport Hotel", latitude: 40.684027, longitude: -74.193377 },
    check: {
      by: DATA_CHECK_BY,
      on: DATA_CHECK_ON,
      evidence:
        "Same address (1000 Spring St, Elizabeth); identical names; points 84 m apart; parking_room, shuttle 4 AM – 12 AM every 15 min, nothing due at lot, 100% refund. " +
        MAP_STEP_PENDING,
    },
    display: { photoUrl: "https://static.cupid.travel/hotels/494451402.jpg", shuttle: "Shuttle every 15 min, 4 AM – 12 AM" },
  },
  {
    key: "courtyard-newark-liberty",
    airport: "EWR",
    enabled: true,
    disabledReason: null,
    reslab: { ids: { production: 378, staging: null }, name: "Courtyard Newark Liberty", latitude: 40.7094686, longitude: -74.1727594 },
    liteapi: { hotelId: "lp35e1f", name: "Courtyard Newark Liberty International Airport", latitude: 40.709023, longitude: -74.172636 },
    check: {
      by: DATA_CHECK_BY,
      on: DATA_CHECK_ON,
      evidence:
        "Same address (600 US 1 & 9, Newark); points 51 m apart; parking_room, 24/7 shuttle every 30 min, nothing due at lot, 100% refund. " +
        MAP_STEP_PENDING,
    },
    display: { photoUrl: "https://static.cupid.travel/hotels/603414590.jpg", shuttle: "Shuttle every 30 min, 24/7" },
  },
  {
    key: "hilton-newark-airport",
    airport: "EWR",
    enabled: true,
    disabledReason: null,
    reslab: { ids: { production: 320, staging: null }, name: "Hilton Newark Airport Parking", latitude: 40.6867513, longitude: -74.1939484 },
    liteapi: { hotelId: "lp205ac", name: "Hilton Newark Airport", latitude: 40.686609, longitude: -74.19318 },
    check: {
      by: DATA_CHECK_BY,
      on: DATA_CHECK_ON,
      evidence:
        "Same address (1170 Spring St, Elizabeth); points 67 m apart; parking_room, 24/7 shuttle every 20 min, nothing due at lot, 100% refund. " +
        MAP_STEP_PENDING,
    },
    display: { photoUrl: "https://static.cupid.travel/hotels/484394464.jpg", shuttle: "Shuttle every 20 min, 24/7" },
  },
  {
    key: "embassy-suites-newark-airport",
    airport: "EWR",
    enabled: true,
    disabledReason: null,
    reslab: { ids: { production: 277, staging: null }, name: "Embassy Suites Hilton Newark Airport", latitude: 40.6621584, longitude: -74.1771164 },
    liteapi: { hotelId: "lp6ceac", name: "Embassy Suites by Hilton Newark Airport", latitude: 40.662256, longitude: -74.176997 },
    check: {
      by: DATA_CHECK_BY,
      on: DATA_CHECK_ON,
      evidence:
        "Addresses differ in form: ResLab '95 International Blvd', LiteAPI '95 Glimcher Realty Way' (the 18 Oct matcher saw '95 International Boulevard'); points 15 m apart. parking_room, shuttle every 30 min, nothing due at lot, 100% refund. No refundable room in the 11 Nov sample. " +
        MAP_STEP_PENDING,
    },
    display: { photoUrl: "https://static.cupid.travel/hotels/485489800.jpg", shuttle: "Shuttle every 30 min — hours shown before you book" },
  },
  {
    key: "courtyard-newark-elizabeth",
    airport: "EWR",
    enabled: true,
    disabledReason: null,
    reslab: { ids: { production: 323, staging: null }, name: "Courtyard by Marriott Newark Elizabeth", latitude: 40.6628456, longitude: -74.1783567 },
    liteapi: { hotelId: "lp33cc5", name: "Courtyard by Marriott Newark Elizabeth", latitude: 40.663165, longitude: -74.177889 },
    check: {
      by: DATA_CHECK_BY,
      on: DATA_CHECK_ON,
      evidence:
        "Same address (87 International Blvd, Elizabeth); identical names; points 53 m apart; parking_room, 24/7 shuttle every 30 min, nothing due at lot, 100% refund, minimum_booking_days 2. " +
        MAP_STEP_PENDING,
    },
    display: { photoUrl: "https://static.cupid.travel/hotels/486553834.jpg", shuttle: "Shuttle every 30 min, 24/7" },
  },
];

/** Enabled entries for one airport, in map order. */
export function enabledHotelLotsFor(airport: string): HotelLotEntry[] {
  const code = airport.toUpperCase();
  return HOTEL_LOTS.filter((e) => e.enabled && e.airport === code);
}

/** An enabled entry by key and airport, or null (unknown, disabled, or another airport's). */
export function findEnabledHotelLot(airport: string, key: string): HotelLotEntry | null {
  const code = airport.toUpperCase();
  return HOTEL_LOTS.find((e) => e.key === key && e.enabled && e.airport === code) ?? null;
}
