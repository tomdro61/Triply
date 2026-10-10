import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, resendSend } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase(), resendSend: vi.fn() };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/resend/client", () => ({
  resend: { emails: { send: resendSend } },
  FROM_EMAIL: "Triply <bookings@triplypro.com>",
}));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn(), setExtras: vi.fn() }),
  flush: vi.fn().mockResolvedValue(true),
}));

import { GET } from "../route";

const CRON_SECRET = process.env.CRON_SECRET as string;
// 2026-10-09 23:00 UTC — the scheduled run; 19:00 in New York.
const NOW = new Date("2026-10-09T23:00:00Z");

function req(auth: string | null = `Bearer ${CRON_SECRET}`) {
  return new NextRequest("https://www.triplypro.com/api/cron/post-trip-review", {
    headers: auth ? { authorization: auth } : {},
  });
}

let n = 0;
function booking(o: Record<string, unknown> = {}) {
  n++;
  const customerId = `cust-${n}`;
  db.tables.customers.push({ id: customerId, email: `traveller${n}@example.com`, first_name: "Sam" });
  const row = {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    customer_id: customerId,
    status: "confirmed",
    cancel_state: null,
    check_out: "2026-10-09T10:00:00",
    location_name: "Jet Parking JFK",
    airport_code: "JFK",
    reslab_location_id: 10,
    direct_lot_id: null,
    location_timezone: "America/New_York",
    livemode: true,
    ...o,
  };
  db.tables.bookings.push(row);
  return row;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db.clearFailures();
  db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [], review_emails: [], booking_reviews: [] };
  resendSend.mockReset();
  resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  process.env.POST_TRIP_REVIEW_EMAILS_ENABLED = "true";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.POST_TRIP_REVIEW_EMAILS_ENABLED;
});

describe("GET /api/cron/post-trip-review", () => {
  it("refuses without the cron secret", async () => {
    expect((await GET(req(null))).status).toBe(401);
    expect((await GET(req("Bearer wrong"))).status).toBe(401);
  });

  it("does nothing unless enabled", async () => {
    delete process.env.POST_TRIP_REVIEW_EMAILS_ENABLED;
    booking();
    const res = await GET(req());
    expect(await res.json()).toEqual({ ok: true, disabled: true });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("fails closed (503) without REVIEW_SIGNING_SECRET", async () => {
    const saved = process.env.REVIEW_SIGNING_SECRET;
    delete process.env.REVIEW_SIGNING_SECRET;
    try {
      booking();
      const res = await GET(req());
      expect(res.status).toBe(503);
      expect(resendSend).not.toHaveBeenCalled();
      expect(db.tables.review_emails).toEqual([]);
    } finally {
      process.env.REVIEW_SIGNING_SECRET = saved;
    }
  });

  it("emails a due booking once, skips the rest, and is idempotent on a second run", async () => {
    const due = booking();
    booking({ status: "cancelled" });
    booking({ livemode: false });
    booking({ check_out: "2026-10-09T21:00:00" }); // not checked out yet in NY

    const first = await GET(req());
    const body = await first.json();
    expect(first.status).toBe(200);
    expect(body).toMatchObject({ ok: true, sent: 1, initialCandidates: 1 });
    expect(resendSend).toHaveBeenCalledTimes(1);
    const [payload, opts] = resendSend.mock.calls[0];
    const cust = db.tables.customers.find((c) => c.id === due.customer_id);
    expect(payload.to).toEqual([cust?.email]);
    expect(payload.subject).toBe("How was parking at Jet Parking JFK?");
    expect(payload.replyTo).toBe("support@triplypro.com");
    expect(opts).toEqual({ idempotencyKey: `post-trip-review/${due.id}/initial` });
    expect(db.tables.review_emails).toMatchObject([{ booking_id: due.id, kind: "initial", status: "sent" }]);

    const second = await GET(req());
    expect(await second.json()).toMatchObject({ ok: true, sent: 0 });
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("sends the one reminder three days on, then never again", async () => {
    const b = booking({ check_out: "2026-10-06T10:00:00" });
    db.tables.review_emails.push({
      id: "led-1",
      booking_id: b.id,
      kind: "initial",
      status: "sent",
      sent_at: "2026-10-06T23:00:05Z",
      claimed_at: "2026-10-06T23:00:00Z",
      send_started_at: "2026-10-06T23:00:01Z",
    });
    await GET(req());
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(resendSend.mock.calls[0][1]).toEqual({ idempotencyKey: `post-trip-review/${b.id}/reminder` });

    await GET(req());
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("does not remind a customer who already reviewed", async () => {
    const b = booking({ check_out: "2026-10-06T10:00:00" });
    db.tables.review_emails.push({ id: "led-1", booking_id: b.id, kind: "initial", status: "sent", sent_at: "2026-10-06T23:00:05Z" });
    db.tables.booking_reviews.push({ id: "rev-1", booking_id: b.id, rating: 5 });
    await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("parks a transient Resend failure as retry and sends it on the next run", async () => {
    const b = booking();
    resendSend.mockResolvedValueOnce({ data: null, error: { message: "rate limited", statusCode: 429, name: "rate_limit_exceeded" } });
    const first = await GET(req());
    expect(first.status).toBe(500); // tried, nothing went out — loud for cron alerting
    expect(db.tables.review_emails).toMatchObject([{ booking_id: b.id, status: "retry" }]);

    const second = await GET(req());
    expect(await second.json()).toMatchObject({ sent: 1 });
    expect(db.tables.review_emails).toMatchObject([{ booking_id: b.id, status: "sent" }]);
    expect(db.tables.review_emails).toHaveLength(1);
  });

  it("marks a permanent rejection failed and never retries it", async () => {
    booking();
    resendSend.mockResolvedValueOnce({ data: null, error: { message: "invalid to", statusCode: 422, name: "validation_error" } });
    await GET(req());
    expect(db.tables.review_emails).toMatchObject([{ status: "failed" }]);
    await GET(req());
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("records a Resend idempotency conflict as sent (the email may be out)", async () => {
    booking();
    resendSend.mockResolvedValueOnce({ data: null, error: { message: "conflict", statusCode: 409, name: "invalid_idempotent_request" } });
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ sent: 1, sentUnconfirmed: 1 });
    expect(db.tables.review_emails).toMatchObject([{ status: "sent" }]);
  });

  it("sends nothing when the ledger cannot be read", async () => {
    booking();
    db.failOnce("review_emails", "select", "boom"); // the stale-claim scan
    db.failOnce("booking_reviews", "select", "boom");
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("releases a stale claim that never reached Resend so the booking is judged again", async () => {
    const b = booking();
    db.tables.review_emails.push({
      id: "led-1",
      booking_id: b.id,
      kind: "initial",
      status: "claimed",
      claimed_at: "2026-10-09T22:00:00Z",
      send_started_at: null,
    });
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ sent: 1, staleClaims: { released: 1, alarmed: 0 } });
  });
});
