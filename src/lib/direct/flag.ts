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
 *   - the Reserve buttons (lot page + search slider) stay off for direct lots,
 *   - GET /api/checkout/lot refuses them (503 direct_not_bookable_yet),
 *   - a declared ResLab twin is NOT yet suppressed from search / the lot page /
 *     the sitemap — the ResLab listing keeps selling until the direct one can.
 * A compile-time constant, not an env var: it must flip with the code that
 * makes it true, never ahead of it.
 */
export const DIRECT_BOOKING_OPEN = false as boolean;
