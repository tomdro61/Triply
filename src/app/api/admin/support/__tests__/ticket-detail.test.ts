/**
 * GET /api/admin/support/[id]: admin-only, and the booking is read ONLY for a
 * "matched" ticket, so a saved reply or an evidence file can never quote a
 * reservation under someone else's email. A booking that should exist but
 * can't be read is flagged, never shown as "no booking".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { email: "vin@triplypro.com" } as null | { email: string },
  ticket: null as null | Record<string, unknown>,
  ticketError: null as null | { message: string },
  booking: null as null | Record<string, unknown>,
  bookingError: null as null | { message: string },
  tables: [] as string[],
  signals: 0,
}));

vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));
vi.mock("@/config/admin", () => ({
  isAdminEmail: (e?: string | null) => !!e && ["vin@triplypro.com"].includes(e.toLowerCase()),
  ALERT_EMAILS: [],
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } })),
  createAdminClient: vi.fn(async () => ({
    from(table: string) {
      state.tables.push(table);
      const b = {
        select: () => b,
        eq: () => b,
        abortSignal: () => (state.signals++, b),
        maybeSingle: async () =>
          table === "support_tickets"
            ? { data: state.ticket, error: state.ticketError }
            : { data: state.booking, error: state.bookingError },
      };
      return b;
    },
  })),
}));

import { GET } from "../[id]/route";

const ID = "11111111-1111-4111-8111-111111111111";
const call = (id = ID) => GET(new NextRequest(`https://x/api/admin/support/${id}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  state.user = { email: "vin@triplypro.com" };
  state.ticket = { id: ID, booking_id: "b1", booking_match: "matched" };
  state.ticketError = null;
  state.booking = { id: "b1", reslab_reservation_number: "RL123" };
  state.bookingError = null;
  state.tables = [];
  state.signals = 0;
});

describe("GET /api/admin/support/[id]", () => {
  it("401 signed out, 403 for a non-admin, 400 for a bad id", async () => {
    state.user = null;
    expect((await call()).status).toBe(401);
    state.user = { email: "someone@example.com" };
    expect((await call()).status).toBe(403);
    state.user = { email: "vin@triplypro.com" };
    expect((await call("not-a-uuid")).status).toBe(400);
  });

  it("404 when the ticket doesn't exist; 500 when the read fails", async () => {
    state.ticket = null;
    expect((await call()).status).toBe(404);
    state.ticketError = { message: "boom" };
    expect((await call()).status).toBe(500);
  });

  it("returns the booking for a matched ticket, with every read time-boxed", async () => {
    const body = await (await call()).json();
    expect(body.booking).toEqual(state.booking);
    expect(body.bookingError).toBe(false);
    expect(state.tables).toEqual(["support_tickets", "bookings"]);
    expect(state.signals).toBe(2);
  });

  it("never reads the booking when the email didn't match", async () => {
    state.ticket = { id: ID, booking_id: "b1", booking_match: "email_mismatch" };
    const body = await (await call()).json();
    expect(body.booking).toBeNull();
    expect(body.bookingError).toBe(false);
    expect(state.tables).toEqual(["support_tickets"]);
  });

  it("a booking that can't be read is flagged, not shown as none", async () => {
    state.bookingError = { message: "timeout" };
    let body = await (await call()).json();
    expect(body).toMatchObject({ booking: null, bookingError: true });
    state.bookingError = null;
    state.booking = null;
    body = await (await call()).json();
    expect(body).toMatchObject({ booking: null, bookingError: true });
  });
});
