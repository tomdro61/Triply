/**
 * The hotel's own parking quote (ResLab min-price), parsed at the trust
 * boundary and checked BEFORE it is used in a price (plan v3 §5.2, L-M1).
 * Pure — the network call lives in hotel-lot-resolve.ts.
 *
 * Checks (any failure hides that hotel and raises an alert — P3's
 * proven-identity rule):
 *   - due_at_location on the QUOTE is 0 (the lot list can be 72 h old)
 *   - discount is 0 (the field exists but is not part of the identity)
 *   - sub_total + fees_total − long_term_discount + tax_total = grand_total, within 1¢
 */

import { z } from "zod";
import { dollarsToCents } from "./pricing";

const money = z.number();
const flag = z.union([z.boolean(), z.number()]).optional();

const minPriceSchema = z.object({
  reservation: z.object({
    grand_total: money,
    sub_total: money,
    fees_total: money,
    long_term_discount: money,
    tax_total: money,
    due_at_location: money,
    discount: money,
    location_commission: money.nullable().optional(),
    sold_out: flag,
    parking_sold_out: flag,
  }),
});

export interface ParkingQuote {
  grandTotalCents: number;
  subTotalCents: number;
  feesTotalCents: number;
  longTermDiscountCents: number;
  taxTotalCents: number;
  /** The lot's share as the quote states it (dollars → cents); null when absent. */
  locationCommissionCents: number | null;
  /** sub_total + fees_total − long_term_discount: the commission base (§5.1). */
  commissionBaseCents: number;
  /** sub_total + fees_total: the service-fee base (service-fee.ts). */
  serviceFeeBaseCents: number;
}

export type QuoteCheckFailure = "malformed" | "due_at_location" | "discount" | "identity" | "unpriced";

export type QuoteCheckResult =
  | { kind: "priced"; quote: ParkingQuote }
  | { kind: "sold_out" }
  | { kind: "failed"; reason: QuoteCheckFailure; detail: string };

const truthy = (v: boolean | number | undefined) => v === true || v === 1;

export function checkParkingQuote(raw: unknown): QuoteCheckResult {
  const parsed = minPriceSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "failed", reason: "malformed", detail: parsed.error.issues.map((i) => i.path.join(".")).join(", ").slice(0, 200) };
  }
  const r = parsed.data.reservation;
  if (truthy(r.sold_out) || truthy(r.parking_sold_out)) return { kind: "sold_out" };

  const grand = dollarsToCents(r.grand_total);
  const sub = dollarsToCents(r.sub_total);
  const fees = dollarsToCents(r.fees_total);
  const ltd = dollarsToCents(r.long_term_discount);
  const tax = dollarsToCents(r.tax_total);
  const due = dollarsToCents(r.due_at_location);
  const discount = dollarsToCents(r.discount);

  if (grand <= 0 || sub < 0 || fees < 0 || ltd < 0 || tax < 0 || sub + fees - ltd < 0) {
    return { kind: "failed", reason: "unpriced", detail: `grand_total ${r.grand_total}` };
  }
  if (due !== 0) return { kind: "failed", reason: "due_at_location", detail: `due_at_location ${r.due_at_location}` };
  if (discount !== 0) return { kind: "failed", reason: "discount", detail: `discount ${r.discount}` };
  const identity = sub + fees - ltd + tax;
  if (Math.abs(identity - grand) > 1) {
    return { kind: "failed", reason: "identity", detail: `sub ${sub} + fees ${fees} − ltd ${ltd} + tax ${tax} = ${identity} ≠ grand ${grand}` };
  }
  const lc = r.location_commission;
  return {
    kind: "priced",
    quote: {
      grandTotalCents: grand,
      subTotalCents: sub,
      feesTotalCents: fees,
      longTermDiscountCents: ltd,
      taxTotalCents: tax,
      locationCommissionCents: typeof lc === "number" ? dollarsToCents(lc) : null,
      commissionBaseCents: sub + fees - ltd,
      serviceFeeBaseCents: sub + fees,
    },
  };
}
