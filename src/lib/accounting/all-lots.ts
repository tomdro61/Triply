import type { DirectBookingDetail, DirectSum } from "./types";

/**
 * Pure helpers for the "All lots" table and the direct-lot CSV on
 * /admin/accounting. No runtime imports, so the page can use them in the browser.
 */

/** ResLab dollars → integer cents (half a cent rounds away from zero, like the page's own formatter). */
export const dollarsToCents = (dollars: number): number => Math.sign(dollars) * Math.round(Math.abs(dollars) * 100);

/**
 * ResLab + direct for one row of the table. null = no total can be shown (the
 * ResLab figure is unknown, the direct figures were not worked out, or no
 * direct booking of several has a figure). `missing` = direct bookings whose
 * figure is not in the total.
 */
export function combinedTotal(reslabCents: number | null, sum: DirectSum | null): { cents: number; missing: number } | null {
  if (reslabCents === null || !sum || (sum.of > 0 && sum.known === 0)) return null;
  return { cents: reslabCents + sum.cents, missing: sum.of - sum.known };
}

const csvMoney = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

/**
 * The direct-lot CSV. Number cells are written plain (a leading minus is a
 * number here, not a formula) and unknown is an empty cell; text goes through
 * `escape` (the shared csvEscape, with formula-injection protection).
 */
export function directCsv(bookings: DirectBookingDetail[], escape: (v: unknown) => string): string {
  const header = [
    "confirmation", "status", "check_in", "check_out", "lot", "state", "reason",
    "received", "refunded", "owed_to_lot", "owed_source", "stripe_fee", "triply_revenue_before_stripe_fees", "triply_keeps",
  ];
  const lines = [header.join(",")];
  for (const b of bookings) {
    lines.push(
      [
        escape(b.reservationNumber), escape(b.status), escape(b.checkIn), escape(b.checkOut), escape(b.lotName),
        escape(b.state), escape(b.reason ?? ""),
        csvMoney(b.receivedCents), csvMoney(b.refundedCents), csvMoney(b.owedToLotCents), escape(b.owedSource ?? ""),
        csvMoney(b.stripeFeeCents), csvMoney(b.grossCents), csvMoney(b.netCents),
      ].join(",")
    );
  }
  return lines.join("\n");
}
