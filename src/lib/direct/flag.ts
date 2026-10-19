/**
 * ENABLE_DIRECT_LOTS — gates only NEW direct-lot DISCOVERY (plan D10 as
 * rewritten by review B13): the search merge, `getLotById`'s direct resolution
 * and the sitemap entries. The checkout and pending routes are gated by
 * `isDirectCheckoutOpen` (DIRECT_BOOKING_OPEN / DIRECT_CHECKOUT_PREVIEW), not by
 * this flag. Nothing downstream of a created booking may read it — a booking
 * that exists is served from its row's `inventory_source`, flag or no flag, so
 * turning the flag off never strands money. Rollback = set false AND redeploy
 * (env changes do not reach running deployments).
 *
 * Flag off ⇒ the search, lot-resolution and sitemap paths are byte-for-byte the
 * pre-direct behaviour.
 */
export function isDirectLotsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ENABLE_DIRECT_LOTS ?? "").trim().toLowerCase() === "true";
}

/**
 * Whether a direct lot can be BOOKED online yet (plan C15's engine-ready
 * switch). Phase 2 lists direct lots; Phases 3–4b ship the checkout and the
 * engine and leave this FALSE (4b plan §0); it flips at go-live (Phase 7).
 * Until then, everything that would take a selling lot offline waits on it too
 * (review M3):
 *   - GET/POST /api/checkout/lot refuse direct lots (503 direct_not_bookable_yet)
 *     unless the preview switch below opens them; the Reserve buttons follow
 *     the same answer through the server-set `lot.checkoutOpen`,
 *   - a declared ResLab twin is NOT yet suppressed from search / the lot page /
 *     the sitemap — the ResLab listing keeps selling until the direct one can.
 * A compile-time constant, not an env var: it must flip with the code that
 * makes it true, never ahead of it.
 */
export const DIRECT_BOOKING_OPEN = true as boolean;

/**
 * Whether a direct lot's CHECKOUT is open in this deployment (review R11):
 * `DIRECT_BOOKING_OPEN`, or the `DIRECT_CHECKOUT_PREVIEW=true` env flag,
 * honoured ONLY on preview / staging / development (never production or an
 * unknown environment). Since 4b-2 (DIRECT_ENGINE_READY = true) the preview
 * flag opens the WHOLE direct booking path in those environments: checkout,
 * staging, fulfilment, capture (Stripe test mode) and the lot notice (to
 * `DIRECT_LOT_NOTICE_OVERRIDE_TO`). Production stays closed until
 * DIRECT_BOOKING_OPEN. Server-side only (env is not in the browser bundle).
 */
const PREVIEW_CHECKOUT_ENVS = new Set(["preview", "staging", "development"]);

export function isDirectCheckoutOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return checkoutOpenFor(env, DIRECT_BOOKING_OPEN);
}

/** `isDirectCheckoutOpen` with the go-live switch passed in — so tests can pin either state. */
export function checkoutOpenFor(env: NodeJS.ProcessEnv, bookingOpen: boolean): boolean {
  if (bookingOpen) return true;
  if ((env.DIRECT_CHECKOUT_PREVIEW ?? "").trim().toLowerCase() !== "true") return false;
  // An ALLOWLIST, not "anything but production": an unknown environment is the
  // most restrictive case (lib/env.ts). Production by either signal is closed.
  if (env.VERCEL_ENV === "production") return false;
  const appEnv = (env.NEXT_PUBLIC_APP_ENV || env.VERCEL_ENV || (env.NODE_ENV === "development" ? "development" : ""))
    .trim()
    .toLowerCase();
  return PREVIEW_CHECKOUT_ENVS.has(appEnv);
}

/**
 * Whether the server may STAGE and fulfil a direct-lot booking (plan C15 /
 * A-29). TRUE since Phase 4b-2, the PR that ships the engine. Production
 * checkout stays closed by DIRECT_BOOKING_OPEN (false) — only preview /
 * staging / development (DIRECT_CHECKOUT_PREVIEW) can create a direct booking,
 * in Stripe test mode.
 * Rollback/drain (4b plan §9.3): DIRECT_CHECKOUT_PREVIEW=false + redeploy,
 * wait for direct pending rows to go terminal, THEN revert — never flip this
 * back while a staged direct row can still be fulfilled.
 */
export const DIRECT_ENGINE_READY = true as boolean;
