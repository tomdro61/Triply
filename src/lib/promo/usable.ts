/**
 * Shared "is this promo code usable" predicate.
 *
 * Extracted so `/api/checkout/lot` (redeeming a code at checkout) and
 * `/api/newsletter` (deciding whether an existing subscriber already has a
 * live code, or needs a fresh one minted) can never silently disagree on what
 * "usable" means. They did disagree once: the newsletter route read a null
 * `max_uses`/`expires_at` as UNUSABLE (`0 < null` and `new Date(null)` are
 * both falsy-ish traps), while checkout correctly treats null as "no limit" /
 * "never expires". That mismatch meant an evergreen code minted a duplicate
 * live code + email on every newsletter submission from the same address.
 */
export interface UsablePromoCodeFields {
  active: boolean;
  expires_at: string | null;
  max_uses: number | null;
  current_uses: number;
}

export function isPromoCodeUsable(promo: UsablePromoCodeFields): boolean {
  return (
    promo.active &&
    (!promo.expires_at || new Date(promo.expires_at) >= new Date()) &&
    (promo.max_uses === null || promo.current_uses < promo.max_uses)
  );
}
