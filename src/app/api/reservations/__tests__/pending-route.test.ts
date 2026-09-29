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
  captureRequiredFieldCheck: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException: sentry.captureException,
  withScope: (fn: (scope: unknown) => void) => {
    sentry.withScope();
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn() });
  },
}));

import { POST } from "../pending/route";
import { capturePaymentError, captureRequiredFieldCheck } from "@/lib/sentry";
import { ReslabError } from "@/lib/reslab/client";
import { REQUIRED_FIELD_LOOKUP_TIMEOUT_MS } from "@/lib/booking/required-extra-fields";
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
    expect(json.error).toMatch(/reload the page/);
    expect(json.error).toMatch(/you have not been charged/);
    expect(json.missingFields).toEqual(["return_flight_number"]);
    expect(db.tables.pending_bookings).toHaveLength(0);
    expect(reslabMock.getLocation).toHaveBeenCalledWith(42);
    // The vehicle step gates the same field, so a server refusal means the two
    // gates disagree or the lot changed: reported, with names and no answers.
    expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith(
      "refused",
      expect.any(String),
      { stripePaymentIntentId: PI, locationId: 42, detail: { missingFields: ["return_flight_number"] } }
    );
    expect(vi.mocked(capturePaymentError)).not.toHaveBeenCalled();
  });

  it("REFUSES a flight field ResLab would reject (N/A), before the charge", async () => {
    const RETURN_FLIGHT = { id: 114, name: "return_flight_number", label: "Return Flight number", type: "both", input_type: "flight_number", per_car: 0 };
    reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: [RETURN_FLIGHT] });
    const res = await POST(req(body({ extraFields: { return_flight_number: "N/A" } })));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe(
      "Enter a flight number (for example DL 460) for: Return Flight number. Please go back to Vehicle Information to correct this — you have not been charged."
    );
    expect(json.error).toMatch(/you have not been charged/);
    expect(json.invalidFields).toEqual(["return_flight_number"]);
    expect(db.tables.pending_bookings).toHaveLength(0);
    expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith(
      "refused",
      expect.any(String),
      { stripePaymentIntentId: PI, locationId: 42, detail: { invalidFields: ["return_flight_number"] } }
    );
  });

  it("stages a flight field in the compact form; refuses one still carrying a space", async () => {
    const RETURN_FLIGHT = { id: 114, name: "return_flight_number", label: "Return Flight number", type: "both", input_type: "flight_number", per_car: 0 };
    reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: [RETURN_FLIGHT] });
    expect((await POST(req(body({ extraFields: { return_flight_number: "DL0460" } })))).status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
    db.tables = { pending_bookings: [], bookings: [] };
    // A real flight number that was not compacted comes from a page loaded
    // before this release: nothing to correct, only to reload.
    const stale = await POST(req(body({ extraFields: { return_flight_number: "DL 460" } })));
    expect(stale.status).toBe(400);
    expect((await stale.json()).error).toBe(
      "This page is out of date. Please reload it and try again — you have not been charged."
    );
    expect(db.tables.pending_bookings).toHaveLength(0);
  });

  it("names every invalid flight field once", async () => {
    reslabMock.getLocation.mockResolvedValue({
      id: 42,
      extra_fields: [
        { id: 1, name: "flight_number", label: "Flight Number", type: "both", input_type: "flight_number" },
        { id: 2, name: "return_flight_number", label: "Return Flight number", type: "both", input_type: "flight_number" },
      ],
    });
    const res = await POST(req(body({ extraFields: { flight_number: "none", return_flight_number: "DL 460" } })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Enter a flight number (for example DL 460) for: Flight Number, Return Flight number. Please go back to Vehicle Information to correct this — you have not been charged."
    );
  });

  it("never tells a customer to enter N/A in a flight field that is missing", async () => {
    reslabMock.getLocation.mockResolvedValue({
      id: 42,
      extra_fields: [{ id: 2, name: "return_flight_number", label: "Return Flight number", type: "both", input_type: "flight_number" }],
    });
    const res = await POST(req(body()));
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/This lot needs: Return Flight number/);
    expect(error).not.toMatch(/N\/A/);
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
    expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith(
      "skipped",
      expect.stringMatching(/required-field check skipped/),
      expect.objectContaining({
        stripePaymentIntentId: PI,
        locationId: 42,
        detail: expect.objectContaining({ reason: expect.stringMatching(/429/) }),
      })
    );
    // Not a payment failure: it must stay out of the payment-error signal.
    expect(vi.mocked(capturePaymentError)).not.toHaveBeenCalled();
  });

  it("FAILS OPEN on a ResLab 5xx and records the status", async () => {
    reslabMock.getLocation.mockRejectedValue(new ReslabError(502, "API request failed: Bad Gateway"));
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith(
      "skipped",
      expect.any(String),
      expect.objectContaining({ detail: expect.objectContaining({ statusCode: 502 }) })
    );
  });

  it("a HANGING ResLab is skipped at the deadline, long before the function limit", async () => {
    vi.useFakeTimers();
    try {
      reslabMock.getLocation.mockReturnValue(new Promise(() => {}));
      const pending = POST(req(body()));
      await vi.advanceTimersByTimeAsync(REQUIRED_FIELD_LOOKUP_TIMEOUT_MS + 1);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(db.tables.pending_bookings).toHaveLength(1);
      expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith(
        "skipped",
        expect.stringMatching(/timed out/),
        expect.objectContaining({ detail: expect.objectContaining({ reason: "timeout" }) })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a lookup that fails AFTER the deadline is not reported a second time", async () => {
    vi.useFakeTimers();
    try {
      let rejectLate: (e: Error) => void = () => {};
      reslabMock.getLocation.mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        })
      );
      const pending = POST(req(body()));
      await vi.advanceTimersByTimeAsync(REQUIRED_FIELD_LOOKUP_TIMEOUT_MS + 1);
      expect((await pending).status).toBe(200);
      rejectLate(new ReslabError(404, "API request failed: Not Found"));
      await vi.advanceTimersByTimeAsync(10);
      expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith("skipped", expect.any(String), expect.anything());
      expect(db.tables.pending_bookings).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a 404 from the ResLab LOGIN is a fault, not a missing lot: fails open", async () => {
    reslabMock.getLocation.mockRejectedValue(new ReslabError(404, "Authentication failed: Not Found"));
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith(
      "skipped",
      expect.any(String),
      expect.objectContaining({ detail: expect.objectContaining({ statusCode: 404 }) })
    );
  });

  it("a location with NO extra_fields key is an unrecognised response: skipped, reported, still stages", async () => {
    reslabMock.getLocation.mockResolvedValue({ id: 42 });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith(
      "skipped",
      expect.stringMatching(/unexpected extra_fields shape/),
      expect.objectContaining({ detail: { issue: "extra_fields key absent from the location" } })
    );
  });

  it("REFUSES before the charge when ResLab says the lot no longer exists (404 is not a blip)", async () => {
    reslabMock.getLocation.mockRejectedValue(new ReslabError(404, "API request failed: Not Found"));
    const res = await POST(req(body()));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no longer available/);
    expect(json.error).toMatch(/you have not been charged/);
    expect(db.tables.pending_bookings).toHaveLength(0);
    expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith(
      "lot_not_found",
      expect.any(String),
      expect.objectContaining({ stripePaymentIntentId: PI, locationId: 42 })
    );
  });

  it("FAILS OPEN, loudly, on an extra_fields shape it can't read", async () => {
    reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: [{ label: "nameless", type: "parking" }] });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith(
      "skipped",
      expect.stringMatching(/unexpected extra_fields shape/),
      expect.anything()
    );
  });

  it("extra_fields that is not a list is skipped, reported, and still stages", async () => {
    reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: { name: "x" } });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(vi.mocked(captureRequiredFieldCheck)).toHaveBeenCalledWith(
      "skipped",
      expect.stringMatching(/unexpected extra_fields shape/),
      expect.anything()
    );
  });

  it.each([[null], [undefined]])("an explicit extra_fields: %s means the lot declares nothing: stages, nothing reported", async (value) => {
    reslabMock.getLocation.mockResolvedValue({ id: 42, extra_fields: value });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(vi.mocked(captureRequiredFieldCheck)).not.toHaveBeenCalled();
  });

  it("a declared field with NO type still counts as required (one odd field never disables the gate)", async () => {
    reslabMock.getLocation.mockResolvedValue({
      id: 42,
      extra_fields: [{ id: 5, name: "ship", label: "Name of Ship", type: null }, FLIGHT],
    });
    const res = await POST(req(body({ extraFields: { return_flight_number: "UA 12" } })));
    expect(res.status).toBe(400);
    expect((await res.json()).missingFields).toEqual(["ship"]);
    expect(db.tables.pending_bookings).toHaveLength(0);
  });

  it("a lot that declares nothing stages with exactly one ResLab read and nothing reported", async () => {
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(db.tables.pending_bookings).toHaveLength(1);
    expect(reslabMock.getLocation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureRequiredFieldCheck)).not.toHaveBeenCalled();
  });

  it("an already-booked PaymentIntent never reaches ResLab", async () => {
    db.tables = { pending_bookings: [], bookings: [{ id: "b1", stripe_payment_intent_id: PI }] };
    const res = await POST(req(body()));
    expect(await res.json()).toEqual({ staged: false, reason: "already_booked" });
    expect(reslabMock.getLocation).not.toHaveBeenCalled();
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
