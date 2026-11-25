/**
 * GET /api/admin/support/[id]/booking: admin-only; finds the booking by the
 * ticket's booking_id, else by its reservation number (and then flags an email
 * mismatch); a ticket with neither answers { booking: null } without a query.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { email: "vin@triplypro.com" } as null | { email: string },
  ticket: null as null | { email: string; reservation_number: string | null; booking_id: string | null },
  booking: null as null | Record<string, unknown>,
  bookingError: null as null | { message: string },
  bookingEqs: [] as Array<[string, unknown]>,
  bookingSelects: [] as string[],
  // A booking_id lookup can find nothing while the reservation number still does.
  bookingById: undefined as undefined | null | Record<string, unknown>,
  ticketError: null as null | { message: string },
  note: null as null | { note: string },
  noteError: null as null | { message: string },
  noteReads: 0,
}));

vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));
vi.mock("@/config/admin", () => ({
  isAdminEmail: (e?: string | null) => !!e && ["vin@triplypro.com", "tom@triplypro.com"].includes(e.toLowerCase()),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } })),
  createAdminClient: vi.fn(async () => ({
    from(table: string) {
      let lastEq = "";
      const b = {
        select: (cols: string) => (table === "bookings" && state.bookingSelects.push(cols), b),
        eq: (col: string, v: unknown) => ((lastEq = col), table === "bookings" && state.bookingEqs.push([col, v]), b),
        limit: () => b,
        maybeSingle: async () => {
          if (table === "support_tickets") return { data: state.ticket, error: state.ticketError };
          if (table === "booking_cancellation_notes") return (state.noteReads++, { data: state.note, error: state.noteError });
          if (lastEq === "id" && state.bookingById !== undefined) return { data: state.bookingById, error: state.bookingError };
          return { data: state.booking, error: state.bookingError };
        },
      };
      return b;
    },
  })),
}));

import { GET } from "../[id]/booking/route";
import { captureAPIError } from "@/lib/sentry";

const reportedStages = () =>
  vi.mocked(captureAPIError).mock.calls.map(([, ctx]) => (ctx as { stage?: string }).stage);

const ID = "11111111-1111-4111-8111-111111111111";
const call = (id = ID) => GET(new NextRequest(`https://x/api/admin/support/${id}/booking`), { params: Promise.resolve({ id }) });

const BOOKING = {
  id: "b1",
  reslab_reservation_number: "RTL123",
  status: "confirmed",
  location_name: "Lot A",
  check_in: "2026-12-01 08:00:00",
  check_out: "2026-12-05 18:00:00",
  grand_total: "50.00",
  created_at: "2026-11-20T15:00:00Z",
  customers: { email: "pat@example.com", first_name: "Pat", last_name: "Lee", phone: null },
};

beforeEach(() => {
  state.user = { email: "vin@triplypro.com" };
  state.ticket = { email: "pat@example.com", reservation_number: "RTL123", booking_id: "b1" };
  state.booking = { ...BOOKING };
  state.bookingError = null;
  state.bookingEqs = [];
  state.bookingSelects = [];
  state.bookingById = undefined;
  state.ticketError = null;
  state.note = null;
  state.noteError = null;
  state.noteReads = 0;
  vi.mocked(captureAPIError).mockClear();
});

describe("GET /api/admin/support/[id]/booking", () => {
  it("401 signed out, 403 for a non-admin, 400 for a bad id", async () => {
    state.user = null;
    expect((await call()).status).toBe(401);
    state.user = { email: "someone@example.com" };
    expect((await call()).status).toBe(403);
    state.user = { email: "vin@triplypro.com" };
    expect((await call("not-a-uuid")).status).toBe(400);
  });

  it("404 when the ticket doesn't exist", async () => {
    state.ticket = null;
    expect((await call()).status).toBe(404);
  });

  it("matched ticket: looks up by booking_id and returns the details", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(state.bookingEqs).toEqual([["id", "b1"]]);
    expect(body.booking.reservationNumber).toBe("RTL123");
    expect(body.booking.emailMatchesTicket).toBe(true);
    expect(body.booking.customer.name).toBe("Pat Lee");
  });

  it("no booking_id: falls back to the reservation number and flags a different email", async () => {
    state.ticket = { email: "imposter@example.com", reservation_number: "RTL123", booking_id: null };
    const body = await (await call()).json();
    expect(state.bookingEqs).toEqual([["reslab_reservation_number", "RTL123"]]);
    expect(body.booking.emailMatchesTicket).toBe(false);
  });

  it("no reservation number and no booking: { booking: null } without querying bookings", async () => {
    state.ticket = { email: "pat@example.com", reservation_number: null, booking_id: null };
    const body = await (await call()).json();
    expect(body).toEqual({ booking: null });
    expect(state.bookingEqs).toEqual([]);
  });

  it("number not on file: { booking: null }", async () => {
    state.ticket = { email: "pat@example.com", reservation_number: "RTL999", booking_id: null };
    state.booking = null;
    expect(await (await call()).json()).toEqual({ booking: null });
  });

  it("a database error is a 500, never an empty answer", async () => {
    state.bookingError = { message: "boom" };
    expect((await call()).status).toBe(500);
    state.bookingError = null;
    state.ticketError = { message: "boom" };
    expect((await call()).status).toBe(500);
  });

  it("never selects the staff note from bookings (it lives in a private table, migration 032)", async () => {
    await call();
    expect(state.bookingSelects.length).toBeGreaterThan(0);
    for (const cols of state.bookingSelects) expect(cols).not.toContain("cancellation_note");
  });

  it("a cancelled or refunded booking reads its note from booking_cancellation_notes; a live one doesn't", async () => {
    await call();
    expect(state.noteReads).toBe(0);
    state.booking = { ...BOOKING, status: "refunded" };
    state.note = { note: "Lot overbooked" };
    const body = await (await call()).json();
    expect(state.noteReads).toBe(1);
    expect(body.booking.cancellation).toMatchObject({ note: "Lot overbooked", noteUnavailable: false });
  });

  it("a failed note read says 'unavailable' instead of 'no note'", async () => {
    state.booking = { ...BOOKING, status: "cancelled" };
    state.noteError = { message: "boom" };
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).booking.cancellation).toMatchObject({ note: null, noteUnavailable: true });
    expect(reportedStages()).toContain("cancellation_note");
  });

  it("a normal booking reports nothing to Sentry", async () => {
    await call();
    expect(captureAPIError).not.toHaveBeenCalled();
  });

  it("an inconsistent (negative) paid-online sum is shown as not recorded and reported", async () => {
    state.booking = { ...BOOKING, grand_total: "10.00", due_at_location: "50.00" };
    const body = await (await call()).json();
    expect(body.booking.money.paidOnline).toBeNull();
    expect(reportedStages()).toContain("paid_online_unreadable");
  });

  it("a linked booking that is gone falls back to the reservation number", async () => {
    state.bookingById = null;
    const body = await (await call()).json();
    expect(state.bookingEqs).toEqual([["id", "b1"], ["reslab_reservation_number", "RTL123"]]);
    expect(body.booking.reservationNumber).toBe("RTL123");
    expect(reportedStages()).toContain("linked_booking_missing");
  });
});
