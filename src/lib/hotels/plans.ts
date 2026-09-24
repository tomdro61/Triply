/**
 * Park & Stay — the pure, environment-free constants (parkguard/plans.ts
 * pattern). Safe to import from "use client" components, Zod schemas and
 * tests: no env reads, no fetch, no side effects.
 *
 * Plan: notes/2026-09-18-park-and-stay-plan-v2.md §2.3, §5, §7.
 */

/**
 * Margin applied on top of LiteAPI's NET rate (`retailRate.total` requested at
 * `margin: 0`). `roomSellCents = max(round(net × (1 + this/100)), sspCents)`.
 * Phase A measurement (sandbox, 24 Sept): SSP ≈ net × 1.01 on the JFK sample,
 * so this constant is the binding term and SSP is only a floor-underrun guard.
 * Re-check before Phase E against the production feed.
 */
export const HOTEL_MARGIN_PERCENT = 15;

/** Hotels considered "at the airport": LiteAPI radius search around the airport point. */
export const PARK_STAY_HOTEL_RADIUS_M = 6_000;

/** One room, 1–4 adults (A4). Occupancy changes the rate, so never defaulted. */
export const PARK_STAY_MIN_ADULTS = 1;
export const PARK_STAY_MAX_ADULTS = 4;

/** Which night the room is for, relative to the parking window (A4; "both" is v2). */
export const PARK_STAY_NIGHTS = ["before", "after"] as const;
export type ParkStayNight = (typeof PARK_STAY_NIGHTS)[number];

/**
 * Server-side micro-cache on /api/park-stay/search results, keyed on
 * (airport, derived hotel dates, adults, parking times). A named constant so
 * it can be set to 0; NOT applied on the hotel detail page (§5).
 */
export const PARK_STAY_SEARCH_CACHE_TTL_MS = 60_000;

/**
 * How many hotels we ask LiteAPI to price per search. `/hotels/rates` cost is
 * per hotel id; 30 hotels ≈ 3.5 s in the sandbox sample.
 */
export const PARK_STAY_MAX_HOTELS_PRICED = 20;

/**
 * LiteAPI facility ids that mean "airport shuttle" (plan §1: 17 / 139 / 140).
 * Used for the shuttle badge only — never for pricing or pairing.
 */
export const LITEAPI_SHUTTLE_FACILITY_IDS: ReadonlySet<number> = new Set([17, 139, 140]);
