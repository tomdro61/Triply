/**
 * Contract test for the PRODUCER side of attribution: the pending route must
 * write the parsed cookie onto the staged row, from the cookie only, and only
 * after the body + PaymentIntent checks. Without this, renaming the column or
 * moving the read above the gates leaves every test green and every booking
 * "unknown" forever.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// vi.mock factories are hoisted above every declaration, so the mocks they
// close over must be hoisted too — and the fake must be loaded dynamically
// inside the hoisted block (a static import is not yet initialised there).
const { db, stripeMock, sentry } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    stripeMock: { paymentIntents: { retrieve: vi.fn() } },
    sentry: { captureException: vi.fn(), withScope: vi.fn() },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: stripeMock }));
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: sentry.captureException,
  withScope: (fn: (scope: unknown) => void) => {
    sentry.withScope();
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn() });
  },
}));

import { POST } from "../pending/route";
import { __resetInvalidReportForTests } from "@/lib/attribution/read-request";
import { encodeCookieValue, type AttributionCookie } from "@/lib/attribution/schema";

const PI = "pi_test_pending";
const COOKIE: AttributionCookie = { v: 1, first: { src: "google", med: "cpc", land: "/", at: 1 }, apt: "JFK" };

function body(over: Record<string, unknown> = {}) {
  return {
    locationId: 42,
    costsToken: "tok",
    fromDate: "2026-10-10 10:00:00",
    toDate: "2026-10-14 14:00:00",
    parkingTypeId: 7,
    customer: { firstName: "Ada", lastName: "L", email: "ada@example.com", phone: "555" },
    vehicle: { make: "Volvo", model: "XC60", color: "Blue", licensePlate: "ABC", state: "NY" },
    stripePaymentIntentId: PI,
    protectionPlanCode: null,
    ...over,
  };
}

function req(payload: unknown, cookies: Record<string, string> = {}) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new NextRequest("http://localhost/api/reservations/pending", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetInvalidReportForTests();
  db.tables = { pending_bookings: [], bookings: [] };
  db.log = [];
  stripeMock.paymentIntents.retrieve.mockResolvedValue({
    id: PI,
    amount: 9400,
    livemode: false,
    metadata: { customerEmail: "ada@example.com", locationId: "42" },
  });
});

describe("POST /api/reservations/pending — attribution", () => {
  it("stores the parsed cookie (with GA id) on the pending row", async () => {
    const res = await POST(req(body(), { triply_attr: encodeCookieValue(COOKIE), _ga: "GA1.1.11.22" }));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(db.tables.pending_bookings[0].attribution).toEqual({ ...COOKIE, ga_client_id: "11.22" });
  });

  it("stores NULL when no cookie is present and still stages", async () => {
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings[0].attribution).toBeNull();
  });

  it("stores the invalid marker for a corrupt cookie", async () => {
    const res = await POST(req(body(), { triply_attr: "garbage" }));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings[0].attribution).toEqual({ v: null, invalid: true });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("does NOT read the cookie when the body fails validation (bots cannot reach Sentry without a valid request)", async () => {
    const res = await POST(req({ nope: true }, { triply_attr: "garbage" }));
    expect(res.status).toBe(400);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("does NOT read the cookie when the PaymentIntent check rejects the payload", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: PI,
      amount: 9400,
      livemode: false,
      metadata: { customerEmail: "someone-else@example.com" },
    });
    const res = await POST(req(body(), { triply_attr: "garbage" }));
    expect(res.status).toBe(400);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(db.tables.pending_bookings).toHaveLength(0);
  });

  it("ignores an `attribution` field in the request BODY — the cookie is the only source", async () => {
    const res = await POST(req(body({ attribution: { v: 1, first: { src: "forged", at: 1 } } })));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings[0].attribution).toBeNull();
  });
});
