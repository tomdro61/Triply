/**
 * GET /api/user/bookings — the card's "Booking total" needs discount_amount and
 * its "Due at location" line needs due_at_location, so both must be in the
 * column allowlist; a row whose total is unreadable is reported (the card shows
 * no amount for it).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { state, sentry, sessionClient } = vi.hoisted(() => {
  const state = { selected: "", rows: [] as Record<string, unknown>[] };
  const q = {
    select: (cols: string) => {
      state.selected = cols;
      return q;
    },
    order: async () => ({ data: state.rows, error: null }),
  };
  return {
    state,
    sentry: { captureBookingError: vi.fn() },
    sessionClient: {
      auth: { getUser: async () => ({ data: { user: { id: "u1", email: null } }, error: null }) },
      from: () => q,
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => sessionClient,
  createAdminClient: async () => {
    throw new Error("not used: the user has no email");
  },
}));
vi.mock("@/lib/sentry", () => sentry);

import { GET } from "../route";

const row = (over: Record<string, unknown> = {}) => ({
  id: "b-ok",
  reslab_reservation_number: "RTL1",
  status: "confirmed",
  check_in: "2030-06-15 10:00:00",
  location_timezone: "America/New_York",
  inventory_source: "reslab",
  grand_total: 120,
  subtotal: 100,
  fees_total: 8,
  tax_total: 12,
  triply_service_fee: 5.95,
  discount_amount: 10,
  due_at_location: 90,
  protection_plan: null,
  protection_plan_price: null,
  ...over,
});

describe("GET /api/user/bookings", () => {
  beforeEach(() => {
    sentry.captureBookingError.mockReset();
    state.rows = [];
  });

  it("selects discount_amount and due_at_location and passes them through to the card", async () => {
    state.rows = [row()];
    const res = await GET();
    expect(res.status).toBe(200);
    const cols = state.selected.split(",").map((c) => c.trim());
    expect(cols).toContain("discount_amount");
    expect(cols).toContain("due_at_location");
    const body = (await res.json()) as { bookings: Record<string, unknown>[] };
    expect(body.bookings[0].discount_amount).toBe(10);
    expect(body.bookings[0].due_at_location).toBe(90);
    expect(sentry.captureBookingError).not.toHaveBeenCalled();
  });

  // The route's dedupe Set lives for the module (one server instance), so each
  // test uses its own booking ids.
  it("reports an unreadable row ONCE per booking, under one stable fingerprint", async () => {
    state.rows = [row(), row({ id: "b-legacy", reslab_reservation_number: "RTL2", triply_service_fee: null })];
    expect((await GET()).status).toBe(200);
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentry.captureBookingError.mock.calls[0] as [
      Error,
      { confirmationNumber: string; fingerprint: string[] },
    ];
    expect(err.message).toContain("unreadable booking total");
    expect(err.message).not.toContain("RTL2"); // stable message
    expect(ctx.confirmationNumber).toBe("RTL2");
    expect(ctx.fingerprint).toEqual(["reservation-card-amount-unreadable"]);

    // Reloading My Reservations: no new event for the same row.
    expect((await GET()).status).toBe(200);
    expect((await GET()).status).toBe(200);
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);

    // A different unreadable row is still reported.
    state.rows = [row({ id: "b-legacy-2", reslab_reservation_number: "RTL3", grand_total: null })];
    await GET();
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(2);
  });

  it("does not report an unreadable row that is cancelled (the card shows no amount for it anyway)", async () => {
    state.rows = [row({ id: "b-cancelled", status: "refunded", triply_service_fee: null })];
    await GET();
    expect(sentry.captureBookingError).not.toHaveBeenCalled();
  });
});
