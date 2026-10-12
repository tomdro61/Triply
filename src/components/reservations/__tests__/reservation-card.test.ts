/**
 * My Reservations card (cost-breakdown plan §4, review round 2). The card reads
 * only the booking row — no Stripe anchor — so it shows the whole "Booking
 * total" (grand + fee + premium − promo discount) with "Due at location" as a
 * sub-line, and NEVER claims what the card was charged ("Paid online" is the
 * confirmation page's job). NO amount (never $0.00) when a money column is
 * unreadable or the booking is cancelled.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

import { ReservationCard, type ReservationCardBooking } from "../reservation-card";
import { reservationCardAmounts } from "@/lib/bookings/reservation-card-amounts";

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
  // The ResLab parts the stored total must add up to (it bounds a due amount).
  subtotal: "85.00",
  fees_total: "7.00",
  tax_total: "8.00",
  triply_service_fee: "5.95",
  protection_plan: null,
  protection_plan_price: null,
  discount_amount: "0.00",
  due_at_location: "0.00",
  vehicle_info: null,
  status: "confirmed",
  created_at: "2030-06-01T00:00:00Z",
  cancellable: false,
  ...over,
});

const render = (b: ReservationCardBooking) =>
  renderToStaticMarkup(
    createElement(ReservationCard, {
      booking: b,
      customerEmail: null,
      selfCancelEnabled: false,
      onCancelled: () => {},
    })
  );

const DIRECT_OVERSIZED = {
  inventory_source: "direct",
  reslab_location_id: null,
  direct_lot_id: "1",
  grand_total: "34.63",
  vehicle_surcharge_cents: 1000,
  vehicle_surcharge_tax_cents: 160,
} as const;

describe("ReservationCard — Booking total", () => {
  it("a plain booking: grand total + service fee", () => {
    const html = render(booking());
    expect(html).toContain("Booking total");
    expect(html).toContain("$105.95");
    expect(html).not.toContain("Due at location");
  });

  it("a promo booking shows the total NET of the discount", () => {
    const html = render(
      booking({ discount_amount: "10.00", protection_plan: "Plan A", protection_plan_price: "12.99" })
    );
    // 100 + 5.95 + 12.99 − 10 = 108.94 (the old card showed 118.94)
    expect(html).toContain("$108.94");
    expect(html).not.toContain("$118.94");
  });

  it("a pay-at-lot booking shows the WHOLE booking total, with what is due at the location as a sub-line", () => {
    const html = render(booking({ grand_total: "120.00", subtotal: "105.00", due_at_location: "90.00" }));
    // 120 + 5.95 = 125.95 for the booking; 90 of it at the location. Never a
    // row-derived "paid" figure (35.95): the card has no Stripe anchor.
    expect(html).toContain("Booking total");
    expect(html).toContain("$125.95");
    expect(html).toContain("Due at location $90.00");
    expect(html).not.toContain("$35.95");
    expect(html.indexOf("Booking total")).toBeLessThan(html.indexOf("Due at location"));
  });

  it("never claims what the card was charged", () => {
    for (const b of [
      booking(),
      booking({ discount_amount: "10.00" }),
      booking({ grand_total: "120.00", subtotal: "105.00", due_at_location: "90.00" }),
      booking(DIRECT_OVERSIZED),
    ]) {
      const html = render(b);
      expect(html).not.toMatch(/paid online|charged|to card/i);
    }
  });

  it("DECIMAL strings and numbers sum in cents, not floats", () => {
    const html = render(booking({ grand_total: 0.1, subtotal: 0.1, fees_total: 0, tax_total: 0, triply_service_fee: 0.2 }));
    expect(html).toContain("$0.30");
  });

  it.each([
    ["service fee NULL (legacy row)", { triply_service_fee: null }],
    ["grand_total NULL", { grand_total: null }],
    ["discount_amount NULL", { discount_amount: null }],
    ["grand_total garbage", { grand_total: "abc" }],
    ["plan set without a premium", { protection_plan: "Plan A", protection_plan_price: null }],
    ["total below zero", { discount_amount: "500.00" }],
  ] as const)("%s → no amount at all, never $0.00", (_label, over) => {
    const html = render(booking(over));
    expect(html).not.toContain("Booking total");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("$105.95");
    // The rest of the card still renders.
    expect(html).toContain("Test Lot");
    expect(html).toContain("#RTL900001");
  });

  it("an unreadable due_at_location hides only the due line, not the booking total", () => {
    const html = render(booking({ due_at_location: null }));
    expect(html).toContain("$105.95");
    expect(html).not.toContain("Due at location");
  });

  it.each(["cancelled", "refunded"] as const)(
    "a %s booking shows no amount (it would contradict the refund) and nothing still due",
    (status) => {
      const html = render(
        booking({ grand_total: "40.64", protection_plan: "Plan A", protection_plan_price: "12.99", status })
      );
      expect(html).toContain("Cancelled");
      expect(html).not.toContain("Booking total");
      expect(html).not.toContain("$59.58");
      expect(html).not.toContain("$0.00");
      const payAtLot = render(booking({ grand_total: "120.00", subtotal: "105.00", due_at_location: "90.00", status }));
      expect(payAtLot).not.toContain("Booking total");
      expect(payAtLot).not.toContain("$125.95");
      expect(payAtLot).not.toContain("Due at location");
    }
  );

  it("a cancelled direct booking shows no at-lot estimate", () => {
    const html = render(booking({ ...DIRECT_OVERSIZED, status: "cancelled" }));
    expect(html).not.toContain("Due at the lot");
    expect(html).not.toContain("Booking total");
  });

  it("a direct booking: the oversized-vehicle estimate is due at the lot, outside the booking total", () => {
    const html = render(booking(DIRECT_OVERSIZED));
    expect(html).toContain("$40.58"); // 34.63 + 5.95
    expect(html).toContain("Due at the lot (est.) $11.60");
    expect(html).not.toContain("Due at location");
  });

  it("a direct booking without a surcharge shows no at-lot line", () => {
    const html = render(booking({ inventory_source: "direct", direct_lot_id: "1" }));
    expect(html).not.toContain("Due at the lot");
  });
});

describe("reservationCardAmounts", () => {
  it("unreadable is true only for a LIVE booking whose total cannot be computed", () => {
    expect(reservationCardAmounts(booking({ triply_service_fee: null })).unreadable).toBe(true);
    expect(reservationCardAmounts(booking({ triply_service_fee: null, status: "refunded" })).unreadable).toBe(false);
    expect(reservationCardAmounts(booking({ status: "cancelled" }))).toMatchObject({ bookingTotalCents: null, unreadable: false });
    expect(reservationCardAmounts(booking())).toMatchObject({ bookingTotalCents: 10595, unreadable: false });
  });

  it("the booking total is NOT net of due at location", () => {
    expect(reservationCardAmounts(booking({ grand_total: "120.00", subtotal: "105.00", due_at_location: "90.00" }))).toMatchObject({
      bookingTotalCents: 12595,
      dueAtLocationCents: 9000,
    });
  });

  it("ignores a stray premium when no plan is set (the reconcile rule)", () => {
    expect(
      reservationCardAmounts(booking({ protection_plan: null, protection_plan_price: "12.99" })).bookingTotalCents
    ).toBe(10595);
  });

  it("hides an unreadable direct estimate rather than guessing", () => {
    expect(
      reservationCardAmounts(
        booking({ inventory_source: "direct", vehicle_surcharge_cents: -5, vehicle_surcharge_tax_cents: 0 })
      ).atLotCents
    ).toBe(0);
  });

  it("never reports an at-lot estimate on a ResLab row", () => {
    expect(
      reservationCardAmounts(booking({ vehicle_surcharge_cents: 1000, vehicle_surcharge_tax_cents: 160 })).atLotCents
    ).toBe(0);
  });
});


describe("My Reservations — the shared due rule (Codex round 4)", () => {
  it("a stored due larger than the booking is never shown as payable", () => {
    const a = reservationCardAmounts(booking({ grand_total: "88.00", subtotal: "73.00", triply_service_fee: "6.00", discount_amount: "0", due_at_location: "200.00" }));
    expect(a).toMatchObject({ dueAtLocationCents: 0, dueUnconfirmed: true });
    const html = render(booking({ grand_total: "88.00", subtotal: "73.00", triply_service_fee: "6.00", discount_amount: "0", due_at_location: "200.00" }));
    expect(html).not.toContain("$200.00");
    expect(html).toContain("The lot confirms any amount due on arrival");
  });
  it("a believable due is still shown", () => {
    expect(reservationCardAmounts(booking({ grand_total: "120.00", subtotal: "105.00", due_at_location: "90.00" }))).toMatchObject({ dueAtLocationCents: 9000, dueUnconfirmed: false });
  });
});


describe("My Reservations — an unproven ResLab total is never shown (Codex confirmation pass)", () => {
  it("grand 880 with parts of 88 and a $200 due: no booking total, no $200, the lot-confirms line", () => {
    const b = booking({ grand_total: "880.00", subtotal: "80.00", fees_total: "3.00", tax_total: "5.00", triply_service_fee: "6.00", discount_amount: "612.00", due_at_location: "200.00" });
    expect(reservationCardAmounts(b)).toMatchObject({ bookingTotalCents: null, unreadable: true, dueUnconfirmed: true });
    const html = render(b);
    expect(html).not.toContain("$274.00");
    expect(html).not.toContain("$200.00");
    expect(html).not.toContain("Booking total");
  });
  it("a direct row is not subject to the ResLab parts check", () => {
    expect(reservationCardAmounts(booking({ inventory_source: "direct", subtotal: null, fees_total: null, tax_total: null })).bookingTotalCents).toBe(10595);
  });
});
