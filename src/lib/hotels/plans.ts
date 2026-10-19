/**
 * Park & Stay — the pure, environment-free constants (parkguard/plans.ts
 * pattern). Safe to import from "use client" components, Zod schemas and
 * tests: no env reads, no fetch, no side effects.
 *
 * Plan: notes/2026-10-19-park-stay-search-plan.md (v3) §4, §5.1, §6.
 */

// ───────────────────────── order floor (§5.1, decision D1) ─────────────────────────
//
// Room sell price = max(LiteAPI's suggested selling price, floor), where the
// floor is the room price at which the WHOLE order (room + the hotel's own
// parking + service fee) breaks even at margin m. Measured 19 Oct (V6 re-run,
// §5.3): at m = 0 the floor binds for only 0–2 of the 9 NY/NJ hotels and
// lifts those rooms ~1–3 % above SSP — decision 1A holds in practice. The old
// "SSP ≈ net × 1.01" comment (one sample) is superseded.
//
// All percentages are applied in basis points by pricing.ts; every amount is
// integer cents.

/** Stripe card fee, charged on the WHOLE charge (room + parking + service fee). */
export const STRIPE_FEE_PERCENT = 2.9;
export const STRIPE_FEE_FIXED_CENTS = 30;
/** LiteAPI processing fee, on the room SELL price — conservative until LiteAPI says what it applies to. */
export const LITEAPI_PROCESSING_FEE_PERCENT = 4;
/** ResLab "RL Fee" (channel fee), on the parking base. */
export const RESLAB_CHANNEL_FEE_PERCENT = 5;
/** D1, 19 Oct 2026: the order never loses money. Defined on the whole charge (R + P + F). */
export const ORDER_MARGIN_PERCENT = 0;
/** Occupancy tax on our markup; 0 until the accountant answers M16 (§5.2). */
export const ROOM_TAX_ON_MARKUP_PERCENT = 0;

// ───────────────────────── search inputs (§4.1) ─────────────────────────

/** One room, 1–4 adults. Occupancy changes the rate, so never defaulted. */
export const PARK_STAY_MIN_ADULTS = 1;
export const PARK_STAY_MAX_ADULTS = 4;

/** The hotel night may be up to this many days ahead, airport-local (ResLab's window applies to the parking start, which is on this date). */
export const PARK_STAY_MAX_NIGHT_AHEAD_DAYS = 100;
/** The return date may be up to this many days after the hotel night. */
export const PARK_STAY_MAX_RETURN_AFTER_NIGHT_DAYS = 60;

/** Arrival at the hotel (parking starts): the :00/:30 grid from 12:00 PM to 11:30 PM. */
export const PARK_STAY_ARRIVAL_FIRST_MINUTES = 12 * 60;
export const PARK_STAY_ARRIVAL_LAST_MINUTES = 23 * 60 + 30;
export const PARK_STAY_TIME_SLOT_MINUTES = 30;

// ───────────────────────── supplier calls (§6, §7) ─────────────────────────

/**
 * Server-side micro-cache on /api/park-stay/search results, keyed on every
 * input. Only complete, non-empty answers are stored. A named constant so it
 * can be set to 0; NOT applied on the hotel page (it always prices fresh, §8.4).
 */
export const PARK_STAY_SEARCH_CACHE_TTL_MS = 60_000;

/** The hotel page lists up to this many rates — the cheapest per room key. */
export const PARK_STAY_HOTEL_PAGE_MAX_RATES = 6;

/** ResLab bounds (§6): getLocation 4 s, min-price 8 s — `request()` alone can take getToken 10 s + call 10 s + a 401 retry. */
export const RESLAB_GET_LOCATION_TIMEOUT_MS = 4_000;
export const RESLAB_MIN_PRICE_TIMEOUT_MS = 8_000;
/** Per-process caches for the mapped lots (§6 step 4–5). */
export const RESLAB_LOCATION_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
/** Backoff after a real ResLab 5xx / 429 / network failure on getLocation. */
export const RESLAB_LOCATION_BACKOFF_MS = 10 * 60 * 1000;
/** Backoff after OUR 4 s bound fired (a cold instance, not ResLab refusing) — short, so one slow start doesn't 503 the next 10 minutes. */
export const RESLAB_LOCATION_TIMEOUT_BACKOFF_MS = 60 * 1000;
/** Backoff (and negative quote cache) after a ResLab auth failure or an unexplained failure — once per lot per minute, not per request. */
export const RESLAB_LOCATION_FAILURE_BACKOFF_MS = 60 * 1000;
/** One bounded /authenticate before a fan-out (M1). */
export const RESLAB_TOKEN_WARM_TIMEOUT_MS = 3_000;
/** Recurring per-lot ResLab failures reach Sentry at most this often per lot and stage. */
export const PARK_STAY_TRANSIENT_REPORT_INTERVAL_MS = 10 * 60 * 1000;
export const RESLAB_QUOTE_CACHE_TTL_MS = 5 * 60 * 1000;

/** LiteAPI /hotels/rates timeout (the client keeps it armed through the body). */
export const LITEAPI_RATES_TIMEOUT_MS = 15_000;

/**
 * The request-wide deadline (review pass 2, H1): the routes' maxDuration is
 * 30 s; every leg after the budget RPC is bounded by the time left until
 * start + 28 s, leaving ~2 s for the response. The snapshot read is bounded
 * at 5 s, the warm-up at 3 s, getLocation at 4 s, min-price at 8 s and
 * LiteAPI at 15 s — each also by what is left.
 */
export const PARK_STAY_REQUEST_BUDGET_MS = 28_000;
/** The snapshot read (getChannelLocationsNoSweep) leg. */
export const PARK_STAY_SNAPSHOT_LEG_MS = 5_000;
/** Below this much time left, a ResLab lot fan-out isn't started (503). */
export const PARK_STAY_MIN_RESLAB_LEG_MS = 1_000;
/** Below this much time left, LiteAPI isn't called at all (503, the ticket stays unspent). */
export const PARK_STAY_MIN_LITEAPI_LEG_MS = 3_000;
/** Auth failures reach Sentry at most this often per process. */
export const PARK_STAY_AUTH_REPORT_INTERVAL_MS = 60 * 1000;

/** Guard distances (§3.4): the lot / hotel must lie within this of the recorded point. */
export const PARK_STAY_MAX_DRIFT_M = 300;
