/**
 * The customer cancel route's contract for the OPTIONAL reason: whatever the
 * body is — missing, not JSON, a bogus value — the cancel still runs; only a
 * valid dropdown value reaches the FSM.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { performSelfCancel, sessionClient } = vi.hoisted(() => {
  const booking = {
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
    customers: { email: "c@example.com", first_name: "C", last_name: "T" },
  };
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: booking, error: null }),
  };
  return {
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
