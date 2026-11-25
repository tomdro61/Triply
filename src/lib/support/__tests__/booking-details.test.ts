/**
 * The support panel's booking summary: "Paid online" must equal the Bookings
 * modal's figure, and the email check is what drives the "verify first" warning.
 */
import { describe, it, expect } from "vitest";
import {
  bookingFailureMessage,
  parseBookingAnswer,
  toSupportBookingDetails,
  type SupportBookingRow,
} from "../booking-details";

const row = (over: Partial<SupportBookingRow> = {}): SupportBookingRow => ({
  id: "b1",
  reslab_reservation_number: "RTL123",
  status: "confirmed",
  inventory_source: "reslab",
  location_name: "Lot A",
  location_address: "1 Airport Rd",
  airport_code: "EWR",
  check_in: "2026-12-01 08:00:00",
  check_out: "2026-12-05 18:00:00",
  grand_total: "100.00",
  triply_service_fee: "5.00",
  protection_plan: "basic",
  protection_plan_price: "7.00",
  due_at_location: "20.00",
  discount_amount: "10.00",
  promo_code: "THANKS10",
  vehicle_info: { make: "Honda", model: "Civic", color: "Blue", licensePlate: "ABC123", state: "NJ" },
  created_at: "2026-11-20T15:00:00Z",
  customers: { email: "Pat@Example.com", first_name: "Pat", last_name: "Lee", phone: "555-0100" },
  ...over,
});

describe("toSupportBookingDetails", () => {
  it("paid online = grand total + service fee + premium − due at lot − discount", () => {
    const d = toSupportBookingDetails(row(), "pat@example.com");
    expect(d.money.paidOnline).toBe(82);
    expect(d.money.dueAtLocation).toBe(20);
    expect(d.money.promoCode).toBe("THANKS10");
    expect(d.protection).toEqual({ plan: "basic", price: 7 });
  });

  it("missing or garbage grand total, or a negative sum, is null (not a believable $0.00)", () => {
    expect(toSupportBookingDetails(row({ grand_total: null }), "x@y.com").money.paidOnline).toBeNull();
    expect(toSupportBookingDetails(row({ grand_total: "abc" }), "x@y.com").money.paidOnline).toBeNull();
    expect(toSupportBookingDetails(row({ grand_total: "1.00" }), "x@y.com").money.paidOnline).toBeNull();
  });

  it("a true $0.00 booking is $0.00, not 'not recorded' (float error below zero)", () => {
    // 0.01 + 2.11 - 2.12 is -4.4e-16 in floating point.
    const d = toSupportBookingDetails(
      row({ grand_total: "0.01", triply_service_fee: "2.11", protection_plan_price: null, due_at_location: "2.12", discount_amount: null }),
      "x@y.com"
    );
    expect(d.money.paidOnline).toBe(0);
    expect(Object.is(d.money.paidOnline, -0)).toBe(false);
    // 100% promo
    const promo = toSupportBookingDetails(
      row({ grand_total: "40.00", triply_service_fee: null, protection_plan_price: null, due_at_location: null, discount_amount: "40.00" }),
      "x@y.com"
    );
    expect(promo.money.paidOnline).toBe(0);
  });

  it("optional parts absent count as 0, like the Bookings modal", () => {
    const d = toSupportBookingDetails(
      row({ triply_service_fee: null, protection_plan_price: null, due_at_location: null, discount_amount: null }),
      "x@y.com"
    );
    expect(d.money.paidOnline).toBe(100);
  });

  it("a plan with no recorded price says so instead of $0.00", () => {
    expect(toSupportBookingDetails(row({ protection_plan_price: null }), "x@y.com").protection).toEqual({ plan: "basic", price: null });
  });

  it("matches the ticket email case-insensitively; a different email is flagged", () => {
    expect(toSupportBookingDetails(row(), " PAT@example.com ").emailMatchesTicket).toBe(true);
    expect(toSupportBookingDetails(row(), "someone@else.com").emailMatchesTicket).toBe(false);
    expect(toSupportBookingDetails(row({ customers: null }), "pat@example.com").emailMatchesTicket).toBe(false);
  });

  it("reads the customer from an array join too", () => {
    const d = toSupportBookingDetails(
      row({ customers: [{ email: "pat@example.com", first_name: "Pat", last_name: null, phone: null }] }),
      "pat@example.com"
    );
    expect(d.customer).toEqual({ name: "Pat", email: "pat@example.com", phone: null });
  });

  it("vehicle and plate read naturally; empty vehicle shows nothing", () => {
    const d = toSupportBookingDetails(row(), "pat@example.com");
    expect(d.vehicle.description).toBe("Blue Honda Civic");
    expect(d.vehicle.plate).toBe("ABC123 · NJ");
    const empty = toSupportBookingDetails(row({ vehicle_info: null }), "pat@example.com");
    expect(empty.vehicle).toEqual({ description: null, plate: null, sizeLabel: null });
  });

  it("direct lots carry the at-lot vehicle surcharge; ResLab rows never do", () => {
    const direct = toSupportBookingDetails(
      row({ inventory_source: "direct", vehicle_surcharge_cents: 1500, vehicle_surcharge_tax_cents: 105 }),
      "pat@example.com"
    );
    expect(direct.inventorySource).toBe("direct");
    expect(direct.money.atLotEstimate).toBe(16.05);
    const reslab = toSupportBookingDetails(row({ vehicle_surcharge_cents: 1500 }), "pat@example.com");
    expect(reslab.money.atLotEstimate).toBe(0);
  });

  it("no protection plan or 'none' → null", () => {
    expect(toSupportBookingDetails(row({ protection_plan: "none" }), "a@b.com").protection).toBeNull();
    expect(toSupportBookingDetails(row({ protection_plan: null }), "a@b.com").protection).toBeNull();
  });

  it("cancellation shows only for cancelled or refunded, never for a stray reason on a live booking", () => {
    expect(toSupportBookingDetails(row(), "a@b.com").cancellation).toBeNull();
    expect(toSupportBookingDetails(row({ cancellation_reason: "plans_changed" }), "a@b.com").cancellation).toBeNull();
    const c = toSupportBookingDetails(
      row({ status: "cancelled", cancellation_reason: "lot_sold_out", cancelled_by: "admin" }),
      "a@b.com",
      { note: "Lot full", unavailable: false }
    );
    expect(c.cancellation).toEqual({ reason: "lot_sold_out", note: "Lot full", noteUnavailable: false, by: "admin" });
    const r = toSupportBookingDetails(row({ status: "refunded" }), "a@b.com", { note: null, unavailable: true });
    expect(r.cancellation).toEqual({ reason: null, note: null, noteUnavailable: true, by: null });
  });
});

describe("parseBookingAnswer", () => {
  const good = toSupportBookingDetails(row(), "pat@example.com");

  it("accepts a booking (after a JSON round trip) and an explicit null", () => {
    expect(parseBookingAnswer(JSON.parse(JSON.stringify({ booking: good })))).toEqual({ ok: true, booking: good });
    expect(parseBookingAnswer({ booking: null })).toEqual({ ok: true, booking: null });
    const noDate = toSupportBookingDetails(row({ created_at: null }), "pat@example.com");
    expect(parseBookingAnswer({ booking: noDate })).toEqual({ ok: true, booking: noDate });
  });

  it("anything else is a failure, never 'no booking'", () => {
    for (const bad of [undefined, null, "<html>", {}, { error: "x" }, { booking: {} }, { booking: { ...good, money: {} } }]) {
      expect(parseBookingAnswer(bad)).toEqual({ ok: false });
    }
    expect(parseBookingAnswer({ booking: { ...good, customer: undefined } })).toEqual({ ok: false });
  });
});

describe("bookingFailureMessage", () => {
  it("says what to do for each status", () => {
    expect(bookingFailureMessage(401)).toMatch(/sign in again/i);
    expect(bookingFailureMessage(403)).toMatch(/admins/i);
    expect(bookingFailureMessage(404)).toMatch(/no longer exists/i);
    expect(bookingFailureMessage(500)).toMatch(/error 500/);
  });
});
