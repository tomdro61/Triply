/**
 * The statement GET (JSON + internal CSV) and the re-send route: admin first,
 * this Stripe mode only, and honest errors.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PayoutStripeRead } from "@/lib/direct/payout-stripe";

const { db, stripeReads, stripeCalls, sentry, env, email, user, lot } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    stripeReads: new Map<string, PayoutStripeRead>(),
    stripeCalls: { n: 0 },
    sentry: { captureAPIError: vi.fn() },
    env: { live: true },
    email: { send: vi.fn() },
    user: { current: { email: "tom@triplypro.com" } as { email: string } | null, admin: true },
    lot: { status: "found" as string },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: user.current } }) } }),
  createAdminClient: async () => db,
}));
vi.mock("@/config/admin", () => ({ isAdminEmail: () => user.admin }));
vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/cancellation/source-guard", () => ({ stripeKeyIsLive: () => env.live }));
vi.mock("@/lib/direct/store", () => ({
  fetchDirectLot: async (id: number) =>
    id !== 1
      ? { status: "not_found" }
      : lot.status === "found"
      ? { status: "found", lot: { name: "The Parking Point JFK", timezone: "America/New_York" } }
      : { status: "unavailable", kind: "unavailable", message: "down" },
}));
vi.mock("@/lib/direct/payout-stripe", () => ({
  readPayoutStripeMany: async (ids: string[]) => {
    stripeCalls.n++;
    return new Map(ids.map((id) => [id, stripeReads.get(id)]));
  },
}));
vi.mock("@/lib/direct/payout-email", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/direct/payout-email")>();
  return { ...real, sendStatementEmail: email.send };
});

import { GET } from "../route";
import { POST as RESEND } from "../resend/route";

const okRead = (): PayoutStripeRead => ({ error: null, amountReceivedCents: 5212, amountRefundedCents: 0, piStatus: "succeeded", disputed: false, disputes: "", feeCents: 181 });
const booking = (pi: string, livemode = true) => ({
  inventory_source: "direct", stripe_payment_intent_id: pi, reslab_reservation_number: `TRP-${pi}`, direct_lot_id: "1", livemode,
  status: "confirmed", cancel_state: null, cancel_claimed_at: null, check_in: "2026-09-20T10:00:00", check_out: "2026-09-24T10:00:00",
  location_timezone: "America/New_York", lot_snapshot: null, subtotal: "39.80", tax_total: "6.37", triply_service_fee: "5.95", protection_plan_wholesale: null,
});
const terms = (pi: string, livemode = true) => ({ stripe_payment_intent_id: pi, direct_lot_id: "1", livemode, partner_share_percent: "80.00", tax_collected_by: "lot" });
const statement = (livemode: boolean) => ({
  id: livemode ? "st_live" : "st_test", direct_lot_id: "1", period_month: "2026-09-01", livemode, total_cents: "3821",
  paid_at: "2026-10-05T15:00:00Z", paid_by: "tom@triplypro.com", statement_email_id: null, statement_attempts: 0,
});

const get = (qs: string) => GET(new NextRequest(`https://x.test/api/admin/direct-payouts?${qs}`));
const resend = (body: unknown) => RESEND(new NextRequest("https://x.test/api/admin/direct-payouts/resend", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  db.tables = { bookings: [booking("pi_a")], direct_booking_terms: [terms("pi_a")], direct_lot_payout_lines: [], direct_lot_statements: [] };
  db.log = [];
  db.clearFailures();
  stripeReads.clear();
  stripeReads.set("pi_a", okRead());
  stripeCalls.n = 0;
  sentry.captureAPIError.mockReset();
  email.send.mockReset().mockResolvedValue({ outcome: "sent", emailId: "em_1", to: ["tom@triplypro.com"], test: true });
  env.live = true;
  user.current = { email: "tom@triplypro.com" };
  user.admin = true;
  lot.status = "found";
});

describe("GET /api/admin/direct-payouts", () => {
  it("401 / 403 before any database or Stripe read", async () => {
    user.current = null;
    expect((await get("lot=1&month=2026-09")).status).toBe(401);
    user.current = { email: "x@example.com" };
    user.admin = false;
    expect((await get("lot=1&month=2026-09")).status).toBe(403);
    expect(db.log).toEqual([]);
    expect(stripeCalls.n).toBe(0);
  });

  it("503 (not 404) when the lot store is unavailable", async () => {
    lot.status = "unavailable";
    expect((await get("lot=1&month=2026-09")).status).toBe(503);
  });

  it("400 for a bad month or format", async () => {
    expect((await get("lot=1&month=2026-13")).status).toBe(400);
    expect((await get("lot=1&month=2026-09&format=xlsx")).status).toBe(400);
  });

  it("an open month's internal CSV carries margin; test mode is in the filename", async () => {
    env.live = false;
    db.tables.bookings = [booking("pi_t", false)];
    db.tables.direct_booking_terms = [terms("pi_t", false)];
    stripeReads.set("pi_t", okRead());
    const res = await get("lot=1&month=2026-09&format=csv");
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toContain("triply-internal-1-2026-09-open-test.csv");
    const body = await res.text();
    expect(body).toContain('"Margin"');
    expect(body).toContain('"TRP-pi_t"');
  });

  it("a paid month's internal CSV is the recorded ledger, with notes", async () => {
    db.tables.direct_lot_statements = [statement(true)];
    db.tables.direct_lot_payout_lines = [
      { id: "l1", statement_id: "st_live", stripe_payment_intent_id: "pi_a", reservation_number: "TRP-pi_a", direct_lot_id: "1", livemode: true, kind: "payout", amount_cents: "3821", decision: "manual", basis: { checkOut: "2026-09-24 10:00:00" }, note: "dispute won", decided_by: "tom@triplypro.com" },
    ];
    const res = await get("lot=1&month=2026-09&format=csv");
    expect(res.headers.get("content-disposition")).toContain("-paid.csv");
    const body = await res.text();
    expect(body).toContain('"TRP-pi_a","2026-09-24","payout","manual","tom@triplypro.com","dispute won",38.21');
    expect(body).toContain('"Total",,,,,,38.21');
  });

  it("a failed build is a 500 with Sentry, never an empty statement", async () => {
    db.failOnce("bookings", "select", "boom");
    expect((await get("lot=1&month=2026-09")).status).toBe(500);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/admin/direct-payouts/resend", () => {
  it("staging never finds a production statement", async () => {
    env.live = false;
    db.tables.direct_lot_statements = [statement(true)];
    expect((await resend({ lot: "1", month: "2026-09" })).status).toBe(404);
    expect(email.send).not.toHaveBeenCalled();
  });

  it("re-sends this mode's statement and passes the outcome through", async () => {
    db.tables.direct_lot_statements = [statement(false), statement(true)];
    const res = await resend({ lot: "1", month: "2026-09" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ statementId: "st_live", email: { outcome: "sent" } });
    expect(email.send).toHaveBeenCalledWith("st_live", "The Parking Point JFK");
  });

  it("404 for an unpaid month, 400 for a bad body, 401 before any read", async () => {
    expect((await resend({ lot: "1", month: "2026-09" })).status).toBe(404);
    expect((await resend({ lot: "1", month: "Sept" })).status).toBe(400);
    db.log = [];
    user.current = null;
    expect((await resend({ lot: "1", month: "2026-09" })).status).toBe(401);
    expect(db.log).toEqual([]);
  });

  it("a throwing email step is a 500 with Sentry", async () => {
    db.tables.direct_lot_statements = [statement(true)];
    email.send.mockRejectedValue(new Error("db down"));
    expect((await resend({ lot: "1", month: "2026-09" })).status).toBe(500);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });
});
