import { describe, it, expect, vi } from "vitest";
import { render } from "@react-email/render";

/**
 * The HTML actually sent for a US-dollar booking's emails, rendered with the
 * senders' own renderer (`@react-email/render`, which — unlike
 * `renderToStaticMarkup` — writes a `<!-- -->` marker between adjacent text
 * nodes). The snapshot was captured from `main` BEFORE the "US$" label
 * reached the emails: it must never be updated by label work. A change here
 * means the bytes a US customer is sent changed.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://www.triplypro.com";
});

import { BookingConfirmationEmail } from "../templates/booking-confirmation";
import { CancellationConfirmationEmail } from "../templates/cancellation-confirmation";
import { buildCostBreakdown, type CostBreakdownResult } from "@/lib/booking/cost-breakdown";

const ok = (b: CostBreakdownResult) => {
  if (!b.ok) throw new Error(`fixture breakdown not ok: ${b.reason}`);
  return b;
};
const reslab = ok(
  buildCostBreakdown({
    source: "reslab",
    days: 3,
    subtotal: "105.00",
    fees: "15.00",
    longTermDiscount: 0,
    tax: "14.40",
    grandTotal: "134.40",
    dueAtLocation: "20.00",
    serviceFee: "7.20",
    promoDiscount: "0.00",
    promoCode: null,
    expectedPromoCents: null,
    protection: null,
    anchorChargedCents: 12160,
    refundedCents: 0,
    cancelled: false,
  })
);

const booking = {
  customerName: "Ada Lovelace",
  confirmationUrl: "https://www.triplypro.com/confirmation/RTL-TEST",
  confirmationNumber: "RTL900",
  lotName: "ResLab Lot",
  lotAddress: "99 ResLab Avenue",
  checkInDate: "2026-10-20",
  checkOutDate: "2026-10-25",
  checkInTime: "10:00 AM",
  checkOutTime: "2:00 PM",
  totalAmount: 141.6,
  usdLabel: false,
  dueAtLocation: 0,
};
const PLAN = { protectionPlan: "Plan A", protectionPlanPrice: 12.99, pgSyncStatus: "synced" as const };

describe("US baseline — booking confirmation email as sent", () => {
  it("breakdown layout", async () => {
    expect(await render(BookingConfirmationEmail({ ...booking, breakdown: reslab }))).toMatchSnapshot();
  });
  it("anchored fallback layout", async () => {
    expect(
      await render(
        BookingConfirmationEmail({
          ...booking,
          breakdown: { ok: false, reason: "fixture" },
          anchoredFallback: { chargedCents: 14160, due: { kind: "amount", cents: 2000 }, protection: { label: "Plan A", premiumCents: 1299 }, reason: "fixture" },
        })
      )
    ).toMatchSnapshot();
  });
  it("legacy layout: part due at the location, with protection", async () => {
    expect(await render(BookingConfirmationEmail({ ...booking, ...PLAN, dueAtLocation: 20 }))).toMatchSnapshot();
  });
  it("legacy layout: nothing due, with protection", async () => {
    expect(await render(BookingConfirmationEmail({ ...booking, ...PLAN }))).toMatchSnapshot();
  });
  it("legacy direct layout: at-lot estimate, a promo and protection", async () => {
    expect(
      await render(
        BookingConfirmationEmail({ ...booking, ...PLAN, direct: { vehicleSizeLabel: "Large SUV / truck", atLotEstimate: 58, discount: 12 } })
      )
    ).toMatchSnapshot();
  });
});

describe("US baseline — cancellation email as sent", () => {
  const cancel = {
    customerName: "Ada Lovelace",
    confirmationNumber: "RTL900",
    lotName: "ResLab Lot",
    lotAddress: "99 ResLab Avenue",
    checkInDate: "2026-10-20",
    checkOutDate: "2026-10-25",
    refundAmount: 135.65,
    wasRefunded: true,
    usdLabel: false,
  };
  it("a plain refund", async () => {
    expect(await render(CancellationConfirmationEmail(cancel))).toMatchSnapshot();
  });
  it("the protection split, the retained part and the service fee", async () => {
    expect(
      await render(CancellationConfirmationEmail({ ...cancel, protectionPlanRefund: 6.99, protectionPlanRetained: 6, serviceFee: 5.95 }))
    ).toMatchSnapshot();
  });
});
