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
const { db, stripeMock, reslabMock, sentry } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    stripeMock: { paymentIntents: { retrieve: vi.fn() } },
    reslabMock: { getLocation: vi.fn() },
    sentry: { captureException: vi.fn(), withScope: vi.fn() },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", () => ({ stripe: stripeMock }));
vi.mock("@/lib/reslab/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reslab/client")>()),
  reslab: reslabMock,
}));
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
import { capturePaymentError } from "@/lib/sentry";
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
  reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: [] });
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

describe("POST /api/reservations/pending — required lot fields (before the charge)", () => {
  // ResLab's own shape: `type` is the product scope; there is no required flag.
  const FLIGHT = { id: 1, name: "return_flight_number", label: "Return flight #", type: "parking", input_type: "text", per_car: 0 };
  const PLATE = { id: 2, name: "license_plate_number", label: "Plate", type: "parking", input_type: "license_plate", per_car: 1 };
  const ROOM = { id: 3, name: "room_note", label: "Room note", type: "room", input_type: "text", per_car: 0 };

  it("REFUSES to stage (so the card is never confirmed) when a declared parking field is blank", async () => {
    reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: [FLIGHT] });
    const res = await POST(req(body({ extraFields: { return_flight_number: "  " } })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Return flight #/);
    expect(json.error).toMatch(/you have not been charged/);
    expect(json.missingFields).toEqual(["return_flight_number"]);
    expect(db.tables.pending_bookings).toHaveLength(0);
    expect(reslabMock.getLocation).toHaveBeenCalledWith(42);
  });

  it("stages when the field is answered (N/A counts)", async () => {
    reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: [FLIGHT, ROOM] });
    const res = await POST(req(body({ extraFields: { return_flight_number: "N/A" } })));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
  });

  it("checks the map fulfilment sends: a lot vehicle spelling filled by the form passes, a missing one is refused", async () => {
    reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: [PLATE] });
    expect((await POST(req(body({ extraFields: { license_plate_number: "ABC" } })))).status).toBe(200);
    db.tables = { pending_bookings: [], bookings: [] };
    expect((await POST(req(body()))).status).toBe(400);
  });

  it("a room-only field never blocks a parking booking", async () => {
    reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: [ROOM] });
    expect((await POST(req(body()))).status).toBe(200);
  });

  it("FAILS OPEN, loudly, when ResLab can't answer — a blip must not block every checkout", async () => {
    reslabMock.getLocation.mockRejectedValue(new Error("429 Too Many Requests"));
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(vi.mocked(capturePaymentError)).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/required-field check skipped.*429/) }),
      expect.objectContaining({ stripePaymentIntentId: PI })
    );
  });

  it("FAILS OPEN, loudly, on an extra_fields shape it can't read", async () => {
    reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: [{ label: "nameless", type: "parking" }] });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(vi.mocked(capturePaymentError)).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/unexpected extra_fields shape/) }),
      expect.anything()
    );
  });

  it("does not call ResLab at all when the PaymentIntent check rejects the payload", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: PI,
      amount: 9400,
      livemode: false,
      metadata: { customerEmail: "someone-else@example.com" },
    });
    expect((await POST(req(body()))).status).toBe(400);
    expect(reslabMock.getLocation).not.toHaveBeenCalled();
  });
});
