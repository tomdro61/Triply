/**
 * The customer cancel route's contract for the OPTIONAL reason: whatever the
 * body is — missing, not JSON, a bogus value — the cancel still runs; only a
 * valid dropdown value reaches the FSM.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { performSelfCancel, sessionClient, BASE_BOOKING, current } = vi.hoisted(() => {
  const booking: Record<string, unknown> = {
    id: "b1",
    status: "confirmed",
    reslab_reservation_number: "RTL1",
    location_name: "Lot",
    location_address: "1 Way",
    check_in: "2030-06-15 10:00:00",
    check_out: "2030-06-20 10:00:00",
    location_timezone: "America/New_York",
    protection_plan: null,
    protection_plan_price: null,
    protection_plan_wholesale: null,
    pg_identifier: null,
    stripe_payment_intent_id: "pi_1",
    inventory_source: "reslab",
    livemode: null,
    customers: { email: "c@example.com", first_name: "C", last_name: "T" },
  };
  // The row the RLS-scoped read returns; a test may replace it.
  const current = { row: booking };
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: current.row, error: null }),
  };
  return {
    BASE_BOOKING: booking,
    current,
    performSelfCancel: vi.fn(),
    sessionClient: {
      auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
      from: () => q,
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/cancellation/perform", () => ({ performSelfCancel }));

import { POST } from "../route";

const params = { params: Promise.resolve({ reservationNumber: "RTL1" }) };
const req = (body?: string) =>
  new NextRequest("https://x.test/api/user/bookings/RTL1/cancel", {
    method: "POST",
    ...(body !== undefined ? { body, headers: { "Content-Type": "application/json" } } : {}),
  });

beforeEach(() => {
  process.env.ENABLE_SELF_SERVE_CANCEL = "true";
  current.row = BASE_BOOKING;
  performSelfCancel.mockReset();
  performSelfCancel.mockResolvedValue({ status: 200, body: { status: "refunded" } });
});

describe("POST /api/user/bookings/[reservationNumber]/cancel — optional reason", () => {
  it("passes a valid dropdown reason to the FSM", async () => {
    const res = await POST(req(JSON.stringify({ reason: "found_cheaper" })), params);
    expect(res.status).toBe(200);
    expect(performSelfCancel.mock.calls[0][2]).toEqual({ reason: "found_cheaper" });
  });

  it.each([
    ["no body", undefined],
    ["empty object", "{}"],
    ["not JSON", "reason=plans_changed"],
    ["unknown value", JSON.stringify({ reason: "lot_turned_away" })],
    ["free text", JSON.stringify({ reason: "the lot was rude" })],
  ])("%s → still cancels, reason null", async (_label, body) => {
    const res = await POST(req(body), params);
    expect(res.status).toBe(200);
    expect(performSelfCancel).toHaveBeenCalledTimes(1);
    expect(performSelfCancel.mock.calls[0][2]).toEqual({ reason: null });
  });
});

/**
 * The route builds the FSM's row field by field. It once dropped
 * inventory_source and livemode, so every direct self-cancel came back
 * "inconsistent" (500) and the Stripe-mode guard never fired (plan 4b §9
 * H-C/H-D). Pin that both reach performSelfCancel exactly as read.
 */
describe("POST /api/user/bookings/[reservationNumber]/cancel — guard fields reach the FSM", () => {
  it("a direct row: inventory_source 'direct' and its TRP- number are passed through", async () => {
    current.row = {
      ...BASE_BOOKING,
      reslab_reservation_number: "TRP-AB12CD34",
      inventory_source: "direct",
      livemode: true,
    };
    const res = await POST(req(), {
      params: Promise.resolve({ reservationNumber: "TRP-AB12CD34" }),
    });
    expect(res.status).toBe(200);
    expect(performSelfCancel.mock.calls[0][0]).toMatchObject({
      reslab_reservation_number: "TRP-AB12CD34",
      inventory_source: "direct",
      livemode: true,
    });
  });

  it("a livemode:false row: livemode is passed through (not dropped to undefined)", async () => {
    current.row = { ...BASE_BOOKING, livemode: false };
    await POST(req(), params);
    const row = performSelfCancel.mock.calls[0][0] as Record<string, unknown>;
    expect(row.livemode).toBe(false);
    expect(row.inventory_source).toBe("reslab");
  });

  it("a pre-015 row: NULL livemode stays NULL (treated as live), never undefined", async () => {
    await POST(req(), params);
    const row = performSelfCancel.mock.calls[0][0] as Record<string, unknown>;
    expect("livemode" in row).toBe(true);
    expect(row.livemode).toBeNull();
  });
});
