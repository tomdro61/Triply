/**
 * ENABLE_DIRECT_LOTS — gates only NEW direct-lot work (plan D10 as rewritten
 * by review B13): the search merge, `getLotById`'s direct resolution, the
 * sitemap entries and, from Phase 3, the direct branches of the checkout and
 * pending routes. Nothing downstream of a created booking may read it — a
 * booking that exists is served from its row's `inventory_source`, flag or
 * no flag, so turning the flag off never strands money. Rollback = set false
 * AND redeploy (env changes do not reach running deployments).
 *
 * Flag off ⇒ every gated code path is byte-for-byte the pre-direct behaviour.
 */
export function isDirectLotsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ENABLE_DIRECT_LOTS ?? "").trim().toLowerCase() === "true";
}

/**
 * Whether a direct lot can be BOOKED online yet (plan C15's engine-ready
 * switch). Phase 2 lists direct lots; Phase 3/4 ship the checkout and flip
 * this to true in the same PR. Until then, everything that would take a
 * selling lot offline waits on it too (review M3):
 *   - GET/POST /api/checkout/lot refuse direct lots (503 direct_not_bookable_yet)
 *     unless the preview switch below opens them; the Reserve buttons follow
 *     the same answer through the server-set `lot.checkoutOpen`,
 *   - a declared ResLab twin is NOT yet suppressed from search / the lot page /
 *     the sitemap — the ResLab listing keeps selling until the direct one can.
 * A compile-time constant, not an env var: it must flip with the code that
 * makes it true, never ahead of it.
 */
export const DIRECT_BOOKING_OPEN = false as boolean;

/**
 * Whether a direct lot's CHECKOUT is open in this deployment (review R11):
 * `DIRECT_BOOKING_OPEN`, or — to click through the vehicle-size pop-up and the
 * checkout before the engine exists — the `DIRECT_CHECKOUT_PREVIEW=true` env
 * flag, honoured ONLY on preview / staging / development (never production or
 * an unknown environment). Opens GET/POST /api/checkout/lot (and, from 3b, the
 * Reserve buttons) only:
 * /api/reservations/pending refuses direct lots until DIRECT_ENGINE_READY, and
 * checkout stages the booking BEFORE confirming the card, so Pay fails closed
 * with no charge. Server-side only (env is not in the browser bundle).
 */
const PREVIEW_CHECKOUT_ENVS = new Set(["preview", "staging", "development"]);

export function isDirectCheckoutOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  if (DIRECT_BOOKING_OPEN) return true;
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
 * A-29). Flipped in Phase 4b, in the PR that ships the engine — never ahead of it.
 */
export const DIRECT_ENGINE_READY = false as boolean;
