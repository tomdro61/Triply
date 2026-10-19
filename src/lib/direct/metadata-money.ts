import { directDays } from "./pricing";
import { DIRECT_TAX_RATE_KEY, decodeTaxRatePercent } from "./vehicle-surcharge-metadata";
import { readProtectionMetadata } from "@/lib/parkguard/plans";
import { convertTo24Hour } from "@/lib/utils/time";

/**
 * The money of a DIRECT-lot booking, read from its PaymentIntent's metadata —
 * the only money authority (plan B8/B9). Stamped in cents by POST
 * /api/checkout/lot (`postDirect`); read by the pending route before the
 * charge and by the engine again before capture.
 *
 * ARITHMETIC ONLY (4b plan §9 H-E). The stamped numbers must agree with each
 * other and with what Stripe holds (`pi.amount`); they are NEVER re-priced
 * against today's business rules — no `computeDirectQuote`, no
 * `calculateServiceFee`, no CMS read. The service fee is taken as stamped: a
 * fee-rule change between checkout and fulfilment (the Sept 14 class) must not
 * block a booking the customer was quoted and charged for.
 *
 * Checked:
 *   subtotal = rate × days
 *   tax      = round(subtotal × taxRate / 100)       (taxRate from directTaxRatePercent)
 *   grand    = subtotal + tax
 *   discount = min(grand, round(subtotal × discountPercent / 100))   (absent ⇒ 0)
 *   parking-only charge (update-pi's baseline) = grand − discount + fee
 *   pi.amount = grand − discount + fee + Park Guard premium
 *   days     = directDays(checkin + time, checkout + time)
 */

declare const checkedByReadDirectMetadataMoney: unique symbol;

/**
 * Branded: only `readDirectMetadataMoney` can produce one, so no caller can
 * hand `fromSnapshot` money built from the staged row's dollar columns (or
 * anything else that skipped the cross-checks). Read-only after the check.
 */
export type DirectMetadataMoney = Readonly<DirectMetadataMoneyFields> & {
  readonly [checkedByReadDirectMetadataMoney]: true;
};

interface DirectMetadataMoneyFields {
  rateCents: number;
  days: number;
  subtotalCents: number;
  taxCents: number;
  grandTotalCents: number;
  discountCents: number;
  serviceFeeCents: number;
  /** 0 when the customer declined Park Guard. */
  protectionPremiumCents: number;
  /** grand − discount + fee + premium — equals `pi.amount`. */
  chargeCents: number;
  taxRatePercent: number;
  discountPercent: number;
}

export type DirectMetadataMoneyResult =
  | { ok: true; money: DirectMetadataMoney }
  | { ok: false; detail: string };

type Meta = Record<string, string | undefined>;

const CENTS_RE = /^(0|[1-9]\d{0,8})$/;
const DAYS_RE = /^[1-9]\d{0,3}$/;
// Any plain decimal: checkout stamps String(promo_codes.discount_percent) and the
// discount is recomputed from the SAME parsed number, so precision cannot drift.
const PERCENT_RE = /^\d{1,3}(\.\d+)?$/;
const TIME_12H_RE = /^\d{1,2}:\d{2}\s[AP]M$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cents(meta: Meta, key: string): number | null {
  const v = meta[key];
  return v !== undefined && CENTS_RE.test(v) ? Number(v) : null;
}

/**
 * Decode and cross-check. `piAmountCents` is Stripe's `pi.amount` (integer
 * cents). Never throws; any missing, malformed or inconsistent key is a
 * `{ ok: false }` the caller refuses on (and reports).
 */
export function readDirectMetadataMoney(meta: Meta, piAmountCents: number): DirectMetadataMoneyResult {
  const fail = (detail: string): DirectMetadataMoneyResult => ({ ok: false, detail });

  const rateCents = cents(meta, "directRateCents");
  const subtotalCents = cents(meta, "directSubtotalCents");
  const taxCents = cents(meta, "directTaxCents");
  const grandTotalCents = cents(meta, "directGrandTotalCents");
  const discountCents = cents(meta, "directDiscountCents");
  const serviceFeeCents = cents(meta, "directServiceFeeCents");
  const parkingOnlyCents = cents(meta, "parkingOnlyChargeAmountCents");
  for (const [key, value] of Object.entries({
    directRateCents: rateCents,
    directSubtotalCents: subtotalCents,
    directTaxCents: taxCents,
    directGrandTotalCents: grandTotalCents,
    directDiscountCents: discountCents,
    directServiceFeeCents: serviceFeeCents,
    parkingOnlyChargeAmountCents: parkingOnlyCents,
  })) {
    if (value === null) return fail(`${key} missing or malformed`);
  }
  // Narrowed by the loop above; restated for the type checker.
  if (
    rateCents === null || subtotalCents === null || taxCents === null || grandTotalCents === null ||
    discountCents === null || serviceFeeCents === null || parkingOnlyCents === null
  ) {
    return fail("unreachable");
  }
  if (rateCents === 0) return fail("directRateCents is 0");

  const daysRaw = meta.directDays;
  if (daysRaw === undefined || !DAYS_RE.test(daysRaw)) return fail("directDays missing or malformed");
  const days = Number(daysRaw);

  const taxRatePercent = decodeTaxRatePercent(meta[DIRECT_TAX_RATE_KEY]);
  if (taxRatePercent === null) return fail(`${DIRECT_TAX_RATE_KEY} missing or malformed`);

  let discountPercent = 0;
  if (meta.discountPercent !== undefined) {
    if (!PERCENT_RE.test(meta.discountPercent)) return fail("discountPercent malformed");
    discountPercent = Number(meta.discountPercent);
    if (!(discountPercent > 0 && discountPercent <= 100)) return fail("discountPercent out of range");
  }

  const protection = readProtectionMetadata(meta);
  if (protection.kind === "invalid" || protection.kind === "legacy_plan_a") {
    return fail(`protection metadata ${protection.kind}`);
  }
  const protectionPremiumCents = protection.kind === "tier" ? Math.round(protection.premium * 100) : 0;

  // Days: the stamped count must be the count of the stamped stay.
  const { checkin, checkout, checkinTime, checkoutTime } = meta;
  if (!checkin || !checkout || !checkinTime || !checkoutTime) return fail("stay dates/times missing");
  if (!DATE_RE.test(checkin) || !DATE_RE.test(checkout) || !TIME_12H_RE.test(checkinTime) || !TIME_12H_RE.test(checkoutTime)) {
    return fail("stay dates/times malformed");
  }
  const range = directDays(`${checkin} ${convertTo24Hour(checkinTime)}:00`, `${checkout} ${convertTo24Hour(checkoutTime)}:00`);
  if (!range.ok) return fail(`stay range ${range.reason}`);
  if (range.days !== days) return fail(`directDays ${days} != ${range.days} from the stay`);

  if (subtotalCents !== rateCents * days) return fail(`subtotal ${subtotalCents} != rate ${rateCents} x ${days}`);
  const expectedTax = Math.round((subtotalCents * taxRatePercent) / 100);
  if (taxCents !== expectedTax) return fail(`tax ${taxCents} != ${expectedTax} at ${taxRatePercent}%`);
  if (grandTotalCents !== subtotalCents + taxCents) return fail(`grand ${grandTotalCents} != subtotal + tax`);
  const expectedDiscount = Math.min(grandTotalCents, Math.round((subtotalCents * discountPercent) / 100));
  if (discountCents !== expectedDiscount) return fail(`discount ${discountCents} != ${expectedDiscount} at ${discountPercent}%`);

  const parkingCharge = grandTotalCents - discountCents + serviceFeeCents;
  if (parkingOnlyCents !== parkingCharge) return fail(`parkingOnlyChargeAmountCents ${parkingOnlyCents} != ${parkingCharge}`);
  if (parkingCharge <= 0) return fail("parking charge is not positive");
  const chargeCents = parkingCharge + protectionPremiumCents;
  if (!Number.isInteger(piAmountCents) || piAmountCents !== chargeCents) {
    return fail(`pi.amount ${piAmountCents} != stamped charge ${chargeCents}`);
  }

  return {
    ok: true,
    money: {
      rateCents,
      days,
      subtotalCents,
      taxCents,
      grandTotalCents,
      discountCents,
      serviceFeeCents,
      protectionPremiumCents,
      chargeCents,
      taxRatePercent,
      discountPercent,
    } as DirectMetadataMoney,
  };
}
