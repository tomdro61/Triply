import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Baseline markup of the RECORD of a US-dollar booking (confirmation page,
 * confirmation email, cancellation email, My Reservations card), captured from
 * `main` BEFORE the "US$" label reached the record of a converted (Canadian)
 * booking. The label may only appear on a booking stamped CAD: for the US
 * bookings below the output must stay byte-identical, so these snapshots are
 * never updated by that work. A snapshot change here means a US customer's
 * page or email changed.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://www.triplypro.com";
});
vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) => createElement("img", { src: props.src, alt: props.alt }),
}));
vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

import { BookingDetails, type PaymentFallback } from "@/components/confirmation/booking-details";
import { ReservationCard, type ReservationCardBooking } from "@/components/reservations/reservation-card";
import { BookingConfirmationEmail } from "@/lib/resend/templates/booking-confirmation";
import { CancellationConfirmationEmail } from "@/lib/resend/templates/cancellation-confirmation";
import { buildCostBreakdown, type CostBreakdownResult, type DirectCostInput, type ReslabCostInput } from "@/lib/booking/cost-breakdown";
import type { AnchoredFallback } from "@/lib/resend/anchored-fallback";
import type { UnifiedLot } from "@/types/lot";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const lot: UnifiedLot = {
  id: "reslab-52",
  source: "reslab",
  sourceId: "52",
  name: "Test Lot",
  slug: "test-lot",
  address: "1 Airport Rd",
  city: "Jamaica",
  state: "NY",
  zipCode: "11430",
  latitude: 40.66,
  longitude: -73.77,
  amenities: [],
  photos: [],
  availability: "available",
};

const reslab = (over: Partial<ReslabCostInput> = {}): CostBreakdownResult =>
  buildCostBreakdown({
    source: "reslab",
    days: 3,
    subtotal: "105.00",
    fees: "15.00",
    longTermDiscount: 0,
    tax: "14.40",
    grandTotal: "134.40",
    dueAtLocation: 0,
    serviceFee: "7.20",
    promoDiscount: "0.00",
    promoCode: null,
    expectedPromoCents: null,
    protection: null,
    anchorChargedCents: 14160,
    refundedCents: 0,
    cancelled: false,
    ...over,
  });

const direct = (over: Partial<DirectCostInput> = {}): CostBreakdownResult =>
  buildCostBreakdown({
    source: "direct",
    days: 2,
    subtotal: "19.90",
    tax: "3.18",
    serviceFee: "5.95",
    promoDiscount: "0.00",
    promoCode: null,
    expectedPromoCents: null,
    protection: { name: "Plan A", premium: "12.99" },
    anchorChargedCents: 4202,
    refundedCents: 0,
    cancelled: false,
    atLot: { surchargeCents: 1000, surchargeTaxCents: 160, vehicleSizeLabel: "Small SUV" },
    ...over,
  });

const ok = (b: CostBreakdownResult) => {
  if (!b.ok) throw new Error(`fixture breakdown not ok: ${b.reason}`);
  return b;
};
const REFUSED: CostBreakdownResult = { ok: false, reason: "fixture" };

describe("US baseline — confirmation page Payment summary", () => {
  const NO_FALLBACK: PaymentFallback = { card: { status: "unknown" }, due: { kind: "none" }, dueContext: { source: "reslab" } };
  const details = (costBreakdown: CostBreakdownResult, fallback: PaymentFallback = NO_FALLBACK, cancelled = false) =>
    html(
      createElement(BookingDetails, {
        lot,
        checkIn: "2026-10-14",
        checkOut: "2026-10-16",
        checkInTime: "9:00 AM",
        checkOutTime: "9:00 AM",
        days: 2,
        costBreakdown,
        fallback,
        cancelled,
      })
    );

  it("ResLab breakdown, nothing due at the location", () => {
    expect(details(ok(reslab()))).toMatchSnapshot();
  });
  it("ResLab breakdown, part due at the location", () => {
    expect(details(ok(reslab({ dueAtLocation: "20.00", anchorChargedCents: 12160 })))).toMatchSnapshot();
  });
  it("ResLab breakdown, cancelled and refunded", () => {
    expect(details(ok(reslab({ cancelled: true, refundedCents: 13440 })), NO_FALLBACK, true)).toMatchSnapshot();
  });
  it("direct breakdown with an at-lot estimate", () => {
    expect(details(ok(direct()))).toMatchSnapshot();
  });
  it("fallback: charged with a refund, and a recorded due amount", () => {
    expect(
      details(REFUSED, {
        card: { status: "charged", chargedCents: 14160, refundedCents: 2000, netPaidCents: 12160 },
        due: { kind: "amount", cents: 2000 },
        dueContext: { source: "reslab" },
      })
    ).toMatchSnapshot();
  });
  it("fallback: direct lot's estimate note", () => {
    expect(
      details(REFUSED, {
        card: { status: "charged", chargedCents: 4202, refundedCents: 0, netPaidCents: 4202 },
        due: { kind: "amount", cents: 1160 },
        dueContext: { source: "direct", estimate: { vehicleSizeLabel: "Small SUV", surcharge: 10, surchargeTax: 1.6 } },
      })
    ).toMatchSnapshot();
  });
});

describe("US baseline — booking confirmation email", () => {
  const base = {
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
    dueAtLocation: 0,
  };
  const email = (props: Record<string, unknown>) =>
    html(createElement(BookingConfirmationEmail, { ...base, ...props } as Parameters<typeof BookingConfirmationEmail>[0]));
  const anchored: AnchoredFallback = {
    chargedCents: 14160,
    due: { kind: "amount", cents: 2000 },
    protection: { label: "Plan A", premiumCents: 1299 },
    reason: "fixture",
  };

  it("ResLab, breakdown layout (part due at the location)", () => {
    expect(email({ breakdown: ok(reslab({ dueAtLocation: "20.00", anchorChargedCents: 12160 })) })).toMatchSnapshot();
  });
  it("direct, breakdown layout (at-lot estimate)", () => {
    expect(
      email({ breakdown: ok(direct()), direct: { vehicleSizeLabel: "Small SUV", atLotEstimate: 11.6, discount: 0 } })
    ).toMatchSnapshot();
  });
  it("anchored fallback layout, ResLab", () => {
    expect(email({ breakdown: REFUSED, anchoredFallback: anchored })).toMatchSnapshot();
  });
  it("anchored fallback layout, direct", () => {
    expect(
      email({
        breakdown: REFUSED,
        anchoredFallback: anchored,
        direct: { vehicleSizeLabel: "Small SUV", atLotEstimate: 20, discount: 0 },
      })
    ).toMatchSnapshot();
  });
  it("legacy layout, ResLab: part due at the location, with protection", () => {
    expect(email({ dueAtLocation: 20, protectionPlan: "Plan A", protectionPlanPrice: 12.99, pgSyncStatus: "synced" })).toMatchSnapshot();
  });
  it("legacy layout, ResLab: nothing due, with protection", () => {
    expect(email({ protectionPlan: "Plan A", protectionPlanPrice: 12.99, pgSyncStatus: "synced" })).toMatchSnapshot();
  });
  it("legacy layout, direct with an at-lot estimate, a promo and protection", () => {
    expect(
      email({
        direct: { vehicleSizeLabel: "Large SUV / truck", atLotEstimate: 58, discount: 12 },
        protectionPlan: "Plan A",
        protectionPlanPrice: 12.99,
        pgSyncStatus: "synced",
      })
    ).toMatchSnapshot();
  });
});

describe("US baseline — cancellation email", () => {
  const base = {
    customerName: "Ada Lovelace",
    confirmationNumber: "RTL900",
    lotName: "ResLab Lot",
    lotAddress: "99 ResLab Avenue",
    checkInDate: "2026-10-20",
    checkOutDate: "2026-10-25",
    refundAmount: 135.65,
    wasRefunded: true,
  };
  it("a plain refund", () => {
    expect(html(createElement(CancellationConfirmationEmail, base))).toMatchSnapshot();
  });
  it("a refund with the protection split, the retained part and the service fee", () => {
    expect(
      html(
        createElement(CancellationConfirmationEmail, {
          ...base,
          protectionPlanRefund: 6.99,
          protectionPlanRetained: 6,
          serviceFee: 5.95,
        })
      )
    ).toMatchSnapshot();
  });
  it("cancelled with no refund", () => {
    expect(html(createElement(CancellationConfirmationEmail, { ...base, refundAmount: 0, wasRefunded: false }))).toMatchSnapshot();
  });
});

describe("US baseline — My Reservations card", () => {
  const booking = (over: Partial<ReservationCardBooking> = {}): ReservationCardBooking => ({
    id: "b1",
    reslab_reservation_number: "RTL900001",
    reslab_location_id: 52,
    inventory_source: "reslab",
    direct_lot_id: null,
    vehicle_surcharge_cents: null,
    vehicle_surcharge_tax_cents: null,
    location_name: "Test Lot",
    location_address: "1 Airport Rd",
    airport_code: "JFK",
    check_in: "2030-06-15T10:00:00",
    check_out: "2030-06-20T10:00:00",
    grand_total: "100.00",
    subtotal: "85.00",
    fees_total: "7.00",
    tax_total: "8.00",
    triply_service_fee: "5.95",
    protection_plan: null,
    protection_plan_price: null,
    discount_amount: "0.00",
    due_at_location: "20.00",
    vehicle_info: null,
    status: "confirmed",
    created_at: "2030-06-01T00:00:00Z",
    cancellable: false,
    ...over,
  });
  const card = (b: ReservationCardBooking, justCancelledRefund?: number | null) =>
    html(
      createElement(ReservationCard, {
        booking: b,
        customerEmail: null,
        selfCancelEnabled: false,
        onCancelled: () => {},
        justCancelledRefund,
      })
    );

  it("ResLab booking with part due at the location", () => {
    expect(card(booking())).toMatchSnapshot();
  });
  it("direct booking with an at-lot estimate", () => {
    expect(
      card(
        booking({
          inventory_source: "direct",
          reslab_location_id: null,
          direct_lot_id: "7",
          reslab_reservation_number: "TRP-AAAA1111",
          due_at_location: "0.00",
          vehicle_surcharge_cents: 1000,
          vehicle_surcharge_tax_cents: 160,
        })
      )
    ).toMatchSnapshot();
  });
  it("just cancelled with a refund", () => {
    expect(card(booking({ status: "refunded" }), 100)).toMatchSnapshot();
  });
});
