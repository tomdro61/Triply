/**
 * Lot-facing notices (4b plan §3.4, §9 M-D, §10 F-2): one claim per kind, the
 * booking notice only while `confirmed`, the cancel notice only after the
 * booking notice went out, recipients by environment + Stripe mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FakeSupabase } from "@/lib/booking/__tests__/supabase-fake";

const db = new FakeSupabase();
const resendSend = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send: resendSend } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
vi.mock("@/lib/sentry", () => ({ captureDirectLotNotice: vi.fn() }));

const { sendLotBookingNotice, sendLotCancelNotice } = await import("../lot-notice");
const { captureDirectLotNotice } = await import("@/lib/sentry");

const PI = "pi_lot";
const content = {
  number: "TRP-AAAA1111",
  lotName: "The Parking Point JFK",
  customerName: "Ada <b>Lovelace</b>",
  customerPhone: "555-0100",
  vehicle: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC123", state: "NY" },
  vehicleSizeLabel: "Large SUV / truck",
  atLotCents: 5800,
  fromDate: "2026-10-20 10:00:00",
  toDate: "2026-10-25 10:00:00",
  parkGuard: false,
  urgent: false,
};

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    stripe_payment_intent_id: PI,
    reslab_reservation_number: "TRP-AAAA1111",
    inventory_source: "direct",
    status: "confirmed",
    location_name: "The Parking Point JFK",
    check_in: "2026-10-20T10:00:00",
    check_out: "2026-10-25T10:00:00",
    vehicle_info: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC123" },
    customer_id: "c1",
    lot_notified_at: null,
    lot_notice_claimed_at: null,
    lot_cancel_notified_at: null,
    lot_cancel_notice_claimed_at: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.clearFailures();
  db.tables = {
    bookings: [booking()],
    customers: [{ id: "c1", first_name: "Ada", last_name: "Lovelace" }],
    direct_booking_terms: [
      { stripe_payment_intent_id: PI, livemode: false, lot_recipients: ["parkingpointjfk@gmail.com"], lot_notice_email_id: null, lot_notice_recipients: null, lot_cancel_notice_email_id: null },
    ],
  };
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  vi.stubEnv("DIRECT_LOT_NOTICE_OVERRIDE_TO", "tom@triplypro.com");
  resendSend.mockResolvedValue({ data: { id: "em_1" }, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("booking notice", () => {
  it("sends once, escapes customer text, stamps lot_notified_at and records the Resend id", async () => {
    expect(await sendLotBookingNotice(PI, content)).toBe("sent");
    expect(await sendLotBookingNotice(PI, content)).toBe("not_claimed");
    expect(resendSend).toHaveBeenCalledTimes(1);
    const [msg, opts] = resendSend.mock.calls[0];
    expect(msg.html).toContain("Ada &lt;b&gt;Lovelace&lt;/b&gt;");
    expect(msg.html).not.toContain("<b>Lovelace</b>");
    expect(opts).toEqual({ idempotencyKey: "direct-lot-notice/booking/b1/test" });
    expect(db.tables.bookings[0].lot_notified_at).toBeTruthy();
    expect(db.tables.direct_booking_terms[0]).toMatchObject({ lot_notice_email_id: "em_1", lot_notice_recipients: ["tom@triplypro.com"] });
  });

  it("never claims a ResLab row", async () => {
    db.tables.bookings = [booking({ inventory_source: "reslab" })];
    expect(await sendLotBookingNotice(PI, content)).toBe("not_claimed");
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("is not sent for a booking that is no longer confirmed (F-2)", async () => {
    db.tables.bookings = [booking({ status: "refunded" })];
    expect(await sendLotBookingNotice(PI, content)).toBe("not_claimed");
  });

  it("a thrown/timed-out send releases the claim so a later re-drive can send", async () => {
    resendSend.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await sendLotBookingNotice(PI, content)).toBe("failed");
    expect(db.tables.bookings[0].lot_notice_claimed_at).toBeNull();
    expect(captureDirectLotNotice).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ outcome: "failed", kind: "booking" }));
    expect(await sendLotBookingNotice(PI, content)).toBe("sent");
  });

  it("a claim left by a dead invocation is stolen only after it goes stale", async () => {
    db.tables.bookings = [booking({ lot_notice_claimed_at: new Date().toISOString() })];
    expect(await sendLotBookingNotice(PI, content)).toBe("not_claimed");
    db.tables.bookings = [booking({ lot_notice_claimed_at: new Date(Date.now() - 6 * 60_000).toISOString() })];
    expect(await sendLotBookingNotice(PI, content)).toBe("sent");
  });

  it("no terms row → failed + alert, nothing claimed", async () => {
    db.tables.direct_booking_terms = [];
    expect(await sendLotBookingNotice(PI, content)).toBe("failed");
    expect(db.tables.bookings[0].lot_notice_claimed_at).toBeNull();
  });
});

describe("cancel notice", () => {
  it("is NOT sent when the lot was never told about the booking (F-2)", async () => {
    db.tables.bookings = [booking({ status: "cancelled" })];
    expect(await sendLotCancelNotice(PI)).toBe("not_claimed");
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("booking notice, then cancel → both fire once, in order", async () => {
    expect(await sendLotBookingNotice(PI, content)).toBe("sent");
    db.tables.bookings[0].status = "refunded";
    expect(await sendLotCancelNotice(PI)).toBe("sent");
    expect(await sendLotCancelNotice(PI)).toBe("not_claimed");
    expect(resendSend).toHaveBeenCalledTimes(2);
    const cancel = resendSend.mock.calls[1][0];
    expect(cancel.subject).toBe("[TEST] CANCELLED — Triply booking TRP-AAAA1111");
    expect(cancel.html).toContain("Ada Lovelace");
    expect(cancel.html).toContain("plate ABC123");
    expect(resendSend.mock.calls[1][1]).toEqual({ idempotencyKey: "direct-lot-notice/cancel/b1/test" });
    expect(db.tables.bookings[0].lot_cancel_notified_at).toBeTruthy();
  });

  it("is never sent for a booking that is still confirmed", async () => {
    db.tables.bookings = [booking({ lot_notified_at: "2026-10-12T15:00:00Z" })];
    expect(await sendLotCancelNotice(PI)).toBe("not_claimed");
  });
});

describe("recipients", () => {
  it("production + live → the lot's own inbox, no [TEST]", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    db.tables.direct_booking_terms[0].livemode = true;
    await sendLotBookingNotice(PI, content);
    expect(resendSend.mock.calls[0][0].to).toEqual(["parkingpointjfk@gmail.com"]);
    expect(resendSend.mock.calls[0][0].subject).not.toMatch(/TEST/);
  });

  it("production + a TEST-mode booking → override inbox with [TEST]", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    await sendLotBookingNotice(PI, content);
    expect(resendSend.mock.calls[0][0].to).toEqual(["tom@triplypro.com"]);
    expect(resendSend.mock.calls[0][0].subject).toMatch(/^\[TEST\]/);
  });

  it("staging + live-mode (impossible today) still never reaches the lot", async () => {
    db.tables.direct_booking_terms[0].livemode = true;
    await sendLotBookingNotice(PI, content);
    expect(resendSend.mock.calls[0][0].to).toEqual(["tom@triplypro.com"]);
  });

  it("override unset off production → skipped, nothing claimed", async () => {
    vi.stubEnv("DIRECT_LOT_NOTICE_OVERRIDE_TO", "");
    expect(await sendLotBookingNotice(PI, content)).toBe("skipped");
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.tables.bookings[0].lot_notice_claimed_at).toBeNull();
  });
});

describe("send outcomes and the claim (pass-1 review)", () => {
  const row = () => db.tables.bookings[0];

  it("Resend never answers → after 5 s 'failed', the claim is KEPT (Resend may have delivered), nothing stamped", async () => {
    vi.useFakeTimers();
    try {
      resendSend.mockReturnValueOnce(new Promise(() => {}));
      const outcome = sendLotBookingNotice(PI, content);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(row().lot_notice_claimed_at).toBeTruthy(); // claimed, still waiting
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
    expect(row().lot_notice_claimed_at).toBeTruthy();
    expect(row().lot_notified_at).toBeNull();
    expect(captureDirectLotNotice).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/did not answer within 5000 ms.*claim kept/) }),
      expect.objectContaining({ outcome: "failed", kind: "booking" })
    );
    // the kept claim is fresh, so an immediate re-drive does not resend
    expect(await sendLotBookingNotice(PI, content)).toBe("not_claimed");
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("'invalid_idempotent_request' means the key already carried an accepted send → 'sent', stamped", async () => {
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "invalid_idempotent_request", message: "same key, different body" } });
    expect(await sendLotBookingNotice(PI, content)).toBe("sent");
    expect(row().lot_notified_at).toBeTruthy();
  });

  it("'concurrent_idempotent_requests' → 'failed', the claim left to the in-flight request", async () => {
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "concurrent_idempotent_requests", message: "in flight", statusCode: 409 } });
    expect(await sendLotBookingNotice(PI, content)).toBe("failed");
    expect(row().lot_notice_claimed_at).toBeTruthy();
    expect(row().lot_notified_at).toBeNull();
  });

  it.each([
    ["application_error, statusCode null (lost / unreadable response)", { name: "application_error", message: "Unable to fetch data", statusCode: null }],
    ["internal_server_error 500", { name: "internal_server_error", message: "upstream failure", statusCode: 500 }],
    ["an unnamed 502 from a gateway", { name: "some_gateway_error", message: "bad gateway", statusCode: 502 }],
    ["any error whose statusCode is null", { name: "missing_required_field", message: "?", statusCode: null }],
  ])("ambiguous Resend error (%s) → 'failed', outcome unknown, claim KEPT, nothing stamped", async (_n, error) => {
    resendSend.mockResolvedValueOnce({ data: null, error });
    expect(await sendLotBookingNotice(PI, content)).toBe("failed");
    expect(row().lot_notice_claimed_at).toBeTruthy();
    expect(row().lot_notified_at).toBeNull();
    expect(captureDirectLotNotice).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/outcome unknown/) }),
      expect.objectContaining({ outcome: "failed", kind: "booking" })
    );
    // the claim is fresh: an immediate re-drive does not resend
    expect(await sendLotBookingNotice(PI, content)).toBe("not_claimed");
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["validation_error 422", { name: "validation_error", message: "bad from address", statusCode: 422 }],
    ["rate_limit_exceeded 429", { name: "rate_limit_exceeded", message: "bad from address", statusCode: 429 }],
  ])("a definite 4xx (%s) → 'failed', claim released for a re-drive", async (_n, error) => {
    resendSend.mockResolvedValueOnce({ data: null, error });
    expect(await sendLotBookingNotice(PI, content)).toBe("failed");
    expect(row().lot_notice_claimed_at).toBeNull();
    expect(row().lot_notified_at).toBeNull();
    expect(captureDirectLotNotice).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/Resend error: bad from address/) }),
      expect.objectContaining({ outcome: "failed" })
    );
    // released ⇒ the next re-drive sends
    expect(await sendLotBookingNotice(PI, content)).toBe("sent");
  });

  it("a claim won from a STALE one is never released, even on a definite 4xx — an earlier attempt may have delivered; gate 2 still lets the cancellation through", async () => {
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "application_error", message: "Unable to fetch data", statusCode: null } });
    expect(await sendLotBookingNotice(PI, content)).toBe("failed");
    expect(row().lot_notice_claimed_at).toBeTruthy();

    // the unknown-outcome claim goes stale; the re-drive takes it over and is rate limited
    row().lot_notice_claimed_at = new Date(Date.now() - 6 * 60_000).toISOString();
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "rate_limit_exceeded", message: "too many requests", statusCode: 429 } });
    expect(await sendLotBookingNotice(PI, content)).toBe("failed");
    expect(row().lot_notice_claimed_at).not.toBeNull(); // NOT released
    expect(row().lot_notified_at).toBeNull();
    expect(resendSend).toHaveBeenCalledTimes(2);
    expect(resendSend.mock.calls[1][1]).toEqual(resendSend.mock.calls[0][1]); // same idempotency key

    // the customer cancels; once the claim is stale again the lot is told
    row().status = "cancelled";
    row().lot_notice_claimed_at = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(await sendLotCancelNotice(PI)).toBe("sent");
    expect(resendSend).toHaveBeenCalledTimes(3);
    expect(resendSend.mock.calls[2][0].subject).toContain("CANCELLED");
    expect(row().lot_cancel_notified_at).toBeTruthy();
  });

  it("a FRESH claim (no prior claim) that gets a 429 is still released", async () => {
    expect(row().lot_notice_claimed_at).toBeNull();
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "rate_limit_exceeded", message: "too many requests", statusCode: 429 } });
    expect(await sendLotBookingNotice(PI, content)).toBe("failed");
    expect(row().lot_notice_claimed_at).toBeNull();
    expect(row().lot_notified_at).toBeNull();
  });

  it("Medium-1: an ambiguous error keeps the claim, the booking is cancelled, the claim goes stale → the cancel notice still reaches the lot (gate 2)", async () => {
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "application_error", message: "Unable to fetch data", statusCode: null } });
    expect(await sendLotBookingNotice(PI, content)).toBe("failed");
    expect(row().lot_notice_claimed_at).toBeTruthy();

    row().status = "cancelled";
    // while the claim is fresh the cancel notice must not overtake a possibly in-flight booking notice
    expect(await sendLotCancelNotice(PI)).toBe("not_claimed");
    row().lot_notice_claimed_at = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(await sendLotCancelNotice(PI)).toBe("sent");

    expect(resendSend).toHaveBeenCalledTimes(2);
    expect(resendSend.mock.calls[1][0].subject).toContain("CANCELLED");
    expect(resendSend.mock.calls[1][1]).toEqual({ idempotencyKey: "direct-lot-notice/cancel/b1/test" });
    expect(row().lot_cancel_notified_at).toBeTruthy();
    // the booking notice is never stamped or re-sent: the row is no longer confirmed
    expect(row().lot_notified_at).toBeNull();
    expect(await sendLotBookingNotice(PI, content)).toBe("not_claimed");
  });

  it("the idempotency key does NOT carry the urgent flag (a re-drive can compute it differently); only the subject differs", async () => {
    expect(await sendLotBookingNotice(PI, { ...content, urgent: true })).toBe("sent");
    db.tables.bookings = [booking()]; // the same booking, un-notified again
    expect(await sendLotBookingNotice(PI, content)).toBe("sent");
    const [urgentCall, normalCall] = resendSend.mock.calls;
    expect(urgentCall[1]).toEqual({ idempotencyKey: "direct-lot-notice/booking/b1/test" });
    expect(normalCall[1]).toEqual(urgentCall[1]);
    expect(urgentCall[0].subject).toMatch(/^\[TEST\] URGENT — late booking — /);
    expect(normalCall[0].subject).not.toMatch(/URGENT/);
  });

  it("a live production send keys as '…/live', not '…/test'", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    db.tables.direct_booking_terms[0].livemode = true;
    await sendLotBookingNotice(PI, content);
    expect(resendSend.mock.calls[0][1]).toEqual({ idempotencyKey: "direct-lot-notice/booking/b1/live" });
  });

  it("timeout, claim goes stale, re-drive now computes URGENT → same key, Resend refuses the changed body → 'sent', ONE notice ever accepted", async () => {
    // A minimal Resend: the first request under a key is accepted; a later one
    // under the same key with a different body is refused as
    // invalid_idempotent_request (Resend's documented behaviour).
    const accepted = new Map<string, string>();
    let hangFirst = true;
    resendSend.mockImplementation((msg: { subject: string; html: string }, opts: { idempotencyKey: string }) => {
      const body = msg.subject + msg.html;
      const prior = accepted.get(opts.idempotencyKey);
      if (prior === undefined) {
        accepted.set(opts.idempotencyKey, body);
        if (hangFirst) {
          hangFirst = false;
          return new Promise(() => {}); // delivered, but the answer never reaches us
        }
        return Promise.resolve({ data: { id: "em_new" }, error: null });
      }
      if (prior !== body) return Promise.resolve({ data: null, error: { name: "invalid_idempotent_request", message: "same key, different body" } });
      return Promise.resolve({ data: { id: "em_cached" }, error: null });
    });

    vi.useFakeTimers();
    try {
      const first = sendLotBookingNotice(PI, content);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await first).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
    expect(row().lot_notice_claimed_at).toBeTruthy();
    expect(row().lot_notified_at).toBeNull();

    // the kept claim goes stale; the re-drive now finds check-in has passed
    row().lot_notice_claimed_at = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(await sendLotBookingNotice(PI, { ...content, urgent: true })).toBe("sent");

    expect(resendSend).toHaveBeenCalledTimes(2);
    expect(resendSend.mock.calls[0][1]).toEqual({ idempotencyKey: "direct-lot-notice/booking/b1/test" });
    expect(resendSend.mock.calls[1][1]).toEqual(resendSend.mock.calls[0][1]);
    expect(resendSend.mock.calls[1][0].subject).toMatch(/URGENT/);
    expect(accepted.size).toBe(1); // the lot received exactly one notice
    expect(row().lot_notified_at).toBeTruthy();
  });

  it("cancelled while the booking notice is in flight → the booking notice stamps AND the cancel notice goes out (F-2)", async () => {
    resendSend.mockImplementationOnce(async () => {
      // the customer cancels while Resend is still answering
      db.tables.bookings[0].status = "cancelled";
      return { data: { id: "em_booking" }, error: null };
    });
    resendSend.mockResolvedValueOnce({ data: { id: "em_cancel" }, error: null });
    expect(await sendLotBookingNotice(PI, content)).toBe("sent");
    expect(resendSend).toHaveBeenCalledTimes(2);
    expect(resendSend.mock.calls[0][0].subject).toMatch(/New Triply booking/);
    expect(resendSend.mock.calls[1][0].subject).toContain("CANCELLED");
    expect(resendSend.mock.calls[1][1]).toEqual({ idempotencyKey: "direct-lot-notice/cancel/b1/test" });
    expect(row().lot_notified_at).toBeTruthy();
    expect(row().lot_cancel_notified_at).toBeTruthy();
    expect(db.tables.direct_booking_terms[0]).toMatchObject({ lot_notice_email_id: "em_booking", lot_cancel_notice_email_id: "em_cancel" });
  });

  it("stamp write fails after Resend accepted → 'sent', the claim is kept so a re-drive does not resend", async () => {
    db.failWhen("bookings", "update", (p) => p != null && "lot_notified_at" in p, "connection reset");
    expect(await sendLotBookingNotice(PI, content)).toBe("sent");
    expect(row().lot_notice_claimed_at).toBeTruthy();
    expect(row().lot_notified_at).toBeNull();
    expect(captureDirectLotNotice).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/not stamped: connection reset/) }),
      expect.objectContaining({ outcome: "sent" })
    );
    expect(await sendLotBookingNotice(PI, content)).toBe("not_claimed");
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("a comma-separated override inbox is split and trimmed", async () => {
    vi.stubEnv("DIRECT_LOT_NOTICE_OVERRIDE_TO", "a@x.com, b@x.com");
    await sendLotBookingNotice(PI, content);
    expect(resendSend.mock.calls[0][0].to).toEqual(["a@x.com", "b@x.com"]);
    expect(db.tables.direct_booking_terms[0].lot_notice_recipients).toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("cancel notice gates and content (pass-1 review)", () => {
  const row = () => db.tables.bookings[0];

  it("gate 2: booking notice claimed > 5 min ago and never stamped (sent-but-unstamped) → the cancellation still reaches the lot", async () => {
    db.tables.bookings = [booking({ status: "cancelled", lot_notified_at: null, lot_notice_claimed_at: new Date(Date.now() - 6 * 60_000).toISOString() })];
    expect(await sendLotCancelNotice(PI)).toBe("sent");
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(resendSend.mock.calls[0][0].subject).toContain("CANCELLED");
    expect(resendSend.mock.calls[0][1]).toEqual({ idempotencyKey: "direct-lot-notice/cancel/b1/test" });
    expect(row().lot_cancel_notified_at).toBeTruthy();
  });

  it("gate 2: a FRESH booking claim (notice in flight, not stamped) → the cancel notice must not overtake it", async () => {
    db.tables.bookings = [booking({ status: "cancelled", lot_notified_at: null, lot_notice_claimed_at: new Date(Date.now() - 60_000).toISOString() })];
    expect(await sendLotCancelNotice(PI)).toBe("not_claimed");
    expect(resendSend).not.toHaveBeenCalled();
    expect(row().lot_cancel_notice_claimed_at).toBeNull();
  });

  it("neither notified nor claimed → 'not_claimed', nothing sent or claimed", async () => {
    db.tables.bookings = [booking({ status: "refunded", lot_notified_at: null, lot_notice_claimed_at: null })];
    expect(await sendLotCancelNotice(PI)).toBe("not_claimed");
    expect(resendSend).not.toHaveBeenCalled();
    expect(row().lot_cancel_notice_claimed_at).toBeNull();
  });

  it("names the GUEST from the staged payload, not the account holder's customers row", async () => {
    db.tables.bookings = [booking({ status: "cancelled", lot_notified_at: "2026-10-12T15:00:00Z" })];
    db.tables.pending_bookings = [{ stripe_payment_intent_id: PI, customer: { firstName: "Grace", lastName: "Hopper" } }];
    // customers row c1 is "Ada Lovelace" — the signed-in account holder
    expect(await sendLotCancelNotice(PI)).toBe("sent");
    const msg = resendSend.mock.calls[0][0];
    expect(msg.html).toContain("Grace Hopper");
    expect(msg.text).toContain("Customer: Grace Hopper");
    expect(msg.html).not.toContain("Ada Lovelace");
    expect(msg.text).not.toContain("Ada Lovelace");
  });

  it("a failed guest read → 'failed', the cancel claim released, nothing sent", async () => {
    db.tables.bookings = [booking({ status: "cancelled", lot_notified_at: "2026-10-12T15:00:00Z" })];
    db.failOnce("pending_bookings", "select", "connection reset");
    expect(await sendLotCancelNotice(PI)).toBe("failed");
    expect(resendSend).not.toHaveBeenCalled();
    expect(row().lot_cancel_notice_claimed_at).toBeNull();
    expect(row().lot_cancel_notified_at).toBeNull();
  });
});
