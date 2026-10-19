// Posts whose readers came looking for a promo code ("dfw parking promo code",
// "iah parking coupon", "lga parking deals"). Matched on whole slug words so
// "code" in "msp-parking-qr-code" (a QR code at the lot) doesn't count.
const PROMO_WORD = /(^|-)(promo|promos|coupon|coupons|discount|discounts|code|codes|deal|deals|groupon|voucher|vouchers)(-|$)/;
const NOT_PROMO = /(^|-)qr-codes?(-|$)/;

export function isPromoPost(slug: string): boolean {
  const s = slug.toLowerCase();
  return PROMO_WORD.test(s) && !NOT_PROMO.test(s);
}
