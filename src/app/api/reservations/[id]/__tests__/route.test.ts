/**
 * GET /api/reservations/[id] — the confirmation page's data source.
 *
 *   - a DIRECT booking (TRP- number, inventory_source "direct") is answered from
 *     the bookings row + lot snapshot with ZERO ResLab calls (plan 4b §2.2);
 *   - a ResLab booking returns exactly what it did before (plus the additive
 *     `inventorySource: "reslab"`);
 *   - 404 (no such booking) stays apart from 500 (a failed read / bad data).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { directRow } from "@/lib/direct/__tests__/reservation-view-fixtures";

type Result = { data: unknown; error: { message: string; code?: string } | null };

const h = vi.hoisted(() => {
  const state: {
    /** The ownership lookup (`.maybeSingle()`): customer_id + customers(email). */
    authRow: { data: unknown; error: { message: string; code?: string } | null };
    /** The detail read (`.single()`). */
    detailRow: { data: unknown; error: { message: string; code?: string } | null };
    detailSelect: string | null;
  } = {
    authRow: { data: null, error: null },
    detailRow: { data: null, error: null },
    detailSelect: null,
  };
  const adminClient = {
    from: (table: string) => {
      if (table !== "bookings") throw new Error(`unexpected table ${table}`);
      let selected = "";
      const q = {
        select: (cols: string) => {
          selected = cols;
          return q;
        },
        eq: () => q,
        maybeSingle: async () => state.authRow,
        single: async () => {
          state.detailSelect = selected;
          return state.detailRow;
        },
      };
      return q;
    },
  };
  return {
    state,
    adminClient,
    getReservation: vi.fn(),
    captureBookingError: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  // Guest (no session) — ownership is proven by ?email=.
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => h.adminClient,
}));
vi.mock("@/lib/reslab/client", () => ({ reslab: { getReservation: h.getReservation } }));
vi.mock("@/lib/sentry", () => ({ captureBookingError: h.captureBookingError }));

import { GET } from "../route";

const EMAIL = "dana@example.com";
const call = (id: string) =>
  GET(new NextRequest(`https://x.test/api/reservations/${id}?email=${encodeURIComponent(EMAIL)}`), {
    params: Promise.resolve({ id }),
  });

const ownedBy = (email: string): Result => ({ data: { customer_id: "c1", customers: { email } }, error: null });

beforeEach(() => {
  h.getReservation.mockReset();
  h.captureBookingError.mockReset();
  h.state.authRow = ownedBy(EMAIL);
  h.state.detailRow = { data: null, error: null };
  h.state.detailSelect = null;
});

describe("direct booking", () => {
  const TRP = "TRP-7K3M9QXA";
  const row = () =>
    directRow({
      triply_service_fee: "5.95",
      check_in: "2026-11-02T08:00:00",
      check_out: "2026-11-05T07:00:00",
      protection_plan: null,
      protection_plan_price: null,
      pg_identifier: null,
      pg_sync_status: null,
    });

  it("builds the response from the row + snapshot and never calls ResLab", async () => {
    h.state.detailRow = { data: row(), error: null };
    const res = await call(TRP);
    expect(res.status).toBe(200);
    expect(h.getReservation).not.toHaveBeenCalled();
    const { reservation } = await res.json();
    expect(reservation.inventorySource).toBe("direct");
    expect(reservation.reservationNumber).toBe(TRP);
    expect(reservation.airportCode).toBe("JFK");
    expect(reservation.location).toMatchObject({ id: "1", latitude: 40.6681, longitude: -73.7914 });
    // Literal airport-local times, exactly as stored (T → space), never converted.
    expect(reservation.items[0]).toMatchObject({ fromDate: "2026-11-02 08:00:00", toDate: "2026-11-05 07:00:00", numberOfDays: 3 });
    // Online figures exclude the at-lot estimate; dueAtLocation is the stored 0.
    expect(reservation.grandTotal).toBe(40.58);
    expect(reservation.dueNow).toBe(40.58);
    expect(reservation.dueAtLocation).toBe(0);
    expect(reservation.atLotEstimate).toEqual({ vehicleSize: "suv", vehicleSizeLabel: "SUV / Van", surcharge: 30, surchargeTax: 4.8, total: 34.8 });
    expect(h.captureBookingError).not.toHaveBeenCalled();
  });

  it("reads the direct columns in the detail select", async () => {
    h.state.detailRow = { data: row(), error: null };
    await call(TRP);
    for (const col of ["inventory_source", "lot_snapshot", "direct_lot_id", "vehicle_size", "vehicle_size_label", "vehicle_surcharge_cents", "vehicle_surcharge_tax_cents"]) {
      expect(h.state.detailSelect).toContain(col);
    }
  });

  it("an admin asking for a TRP- number with no row → 404, no ResLab call", async () => {
    // Guest path 403s first on a missing row; reproduce the admin path by
    // letting the ownership read pass and the detail read find nothing.
    h.state.detailRow = { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } };
    const res = await call(TRP);
    expect(res.status).toBe(404);
    expect(h.getReservation).not.toHaveBeenCalled();
  });

  it("a failed detail read on a TRP- number → 500 (not a ResLab 404)", async () => {
    h.state.detailRow = { data: null, error: { message: "connection reset", code: "08006" } };
    const res = await call(TRP);
    expect(res.status).toBe(500);
    expect(h.getReservation).not.toHaveBeenCalled();
    expect(h.captureBookingError).toHaveBeenCalled();
  });

  it("a snapshot that does not parse → 500 + Sentry, never a guessed page", async () => {
    h.state.detailRow = { data: { ...row(), lot_snapshot: { v: 9 } }, error: null };
    const res = await call(TRP);
    expect(res.status).toBe(500);
    expect(h.getReservation).not.toHaveBeenCalled();
    expect(h.captureBookingError).toHaveBeenCalledTimes(1);
  });

  it("source and number disagree (TRP- number on a reslab row) → 500, no ResLab call", async () => {
    h.state.detailRow = { data: { ...row(), inventory_source: "reslab" }, error: null };
    const res = await call(TRP);
    expect(res.status).toBe(500);
    expect(h.getReservation).not.toHaveBeenCalled();
  });

  it("source and number disagree (RTL number on a direct row) → 500, no ResLab call", async () => {
    h.state.detailRow = { data: row(), error: null };
    const res = await call("RTL123");
    expect(res.status).toBe(500);
    expect(h.getReservation).not.toHaveBeenCalled();
  });

  it("guest with the wrong email → 403 before anything is read", async () => {
    h.state.authRow = ownedBy("someone-else@example.com");
    const res = await call(TRP);
    expect(res.status).toBe(403);
    expect(h.state.detailSelect).toBeNull();
  });
});

describe("ResLab booking — unchanged", () => {
  const RTL = "RTL856901";
  const reslabRow = {
    vehicle_info: { make: "Toyota", model: "Camry", color: "Blue", licensePlate: "XYZ987", state: "NJ" },
    triply_service_fee: "5.95",
    check_in: "2026-10-02T11:30:00",
    check_out: "2026-10-05T07:00:00",
    protection_plan: "Plan A",
    protection_plan_price: "12.99",
    pg_identifier: "PG-9",
    pg_sync_status: "synced",
    inventory_source: "reslab",
    direct_lot_id: null,
    lot_snapshot: null,
    vehicle_size: null,
    vehicle_size_label: null,
    vehicle_surcharge_cents: null,
    vehicle_surcharge_tax_cents: null,
    status: "confirmed",
    subtotal: "60",
    tax_total: "8.82",
    fees_total: "2",
    grand_total: "70.82",
    discount_amount: null,
    due_at_location: "20",
    customers: { first_name: "Sam", last_name: "Lee", email: EMAIL, phone: "5550001111" },
  };
  const reslabReservation = {
    reservation_number: RTL,
    reserved_by: "Sam Lee",
    cancelled: 0,
    history: [
      {
        id: 4242,
        reserved_for: "Sam Q Lee",
        email: EMAIL,
        phone: "5550001111",
        grand_total: 70.82,
        subtotal: 60,
        total_tax: 8.82,
        total_fees: 2,
        due_at_location_total: 20,
        location: {
          id: 52,
          name: "Some ResLab Lot",
          address: "1 Airport Rd",
          city: "Newark",
          state: { code: "NJ" },
          zip_code: "07114",
          phone: "9735550000",
          latitude: "40.69",
          longitude: "-74.17",
        },
        dates: [
          {
            from_date: "2026-10-02 00:00:00",
            to_date: "2026-10-05 00:00:00",
            number_of_days: 3,
            type: { name: "Outdoor" },
            parking_rates: [
              {
                from_date: "2026-10-02 00:00:00",
                to_date: "2026-10-05 00:00:00",
                number_of_days: 3,
                number_of_parkings: 1,
                rate: { location_parking_type: { name: "Outdoor Self Park" } },
              },
            ],
          },
        ],
        extra_fields: [
          { name: "car_make", value: "Toyota" },
          { name: "empty", value: "" },
        ],
      },
    ],
  };

  it("returns the same response as before (one ResLab call; Supabase times win)", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    const res = await call(RTL);
    expect(res.status).toBe(200);
    expect(h.getReservation).toHaveBeenCalledTimes(1);
    expect(h.getReservation).toHaveBeenCalledWith(RTL);
    expect(await res.json()).toEqual({
      reservation: {
        id: 4242,
        reservationNumber: RTL,
        inventorySource: "reslab",
        status: "confirmed",
        grandTotal: 70.82 + 5.95 + 12.99,
        subtotal: 60,
        taxTotal: 8.82,
        feesTotal: 2,
        serviceFee: 5.95,
        protectionPlan: "Plan A",
        protectionPlanPrice: 12.99,
        pgIdentifier: "PG-9",
        pgSyncStatus: "synced",
        dueNow: 70.82 + 5.95 + 12.99 - 20,
        dueAtLocation: 20,
        customer: { firstName: "Sam", lastName: "Q Lee", email: EMAIL, phone: "5550001111" },
        items: [
          {
            type: "parking",
            fromDate: "2026-10-02 11:30:00",
            toDate: "2026-10-05 07:00:00",
            numberOfDays: 3,
            numberOfSpots: 1,
            parkingType: "Outdoor Self Park",
          },
        ],
        location: {
          id: 52,
          name: "Some ResLab Lot",
          address: "1 Airport Rd",
          city: "Newark",
          state: "NJ",
          zipCode: "07114",
          phone: "9735550000",
          latitude: "40.69",
          longitude: "-74.17",
        },
        vehicleInfo: reslabRow.vehicle_info,
        extraFields: { car_make: "Toyota" },
      },
    });
  });

  it("a row whose read failed (inventory_source unknown) still goes to ResLab, as before", async () => {
    h.state.detailRow = { data: null, error: { message: "timeout", code: "57014" } };
    h.getReservation.mockResolvedValue(reslabReservation);
    const res = await call(RTL);
    expect(res.status).toBe(200);
    expect(h.getReservation).toHaveBeenCalledTimes(1);
    expect(h.captureBookingError).toHaveBeenCalledTimes(1); // the failed read is still surfaced
  });

  it("ResLab 404 → 404; other ResLab failure → 500", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockRejectedValueOnce(new Error("ResLab API error 404: not found"));
    expect((await call(RTL)).status).toBe(404);
    h.getReservation.mockRejectedValueOnce(new Error("ResLab API error 502: bad gateway"));
    expect((await call(RTL)).status).toBe(500);
  });
});
