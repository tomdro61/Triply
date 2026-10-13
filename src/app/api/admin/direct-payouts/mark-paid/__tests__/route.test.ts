/**
 * Mark paid: the statement is rebuilt server-side and must match what the
 * admin saw; the ledger write is the database function; the email never
 * decides the response.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PayoutStripeRead } from "@/lib/direct/payout-stripe";

const { db, stripeReads, sentry, env, email, user } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    stripeReads: new Map<string, PayoutStripeRead>(),
    sentry: { captureAPIError: vi.fn() },
    env: { live: true },
    email: { send: vi.fn() },
    user: { current: { email: "tom@triplypro.com" } as { email: string } | null, admin: true },
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
    id === 1 ? { status: "found", lot: { name: "The Parking Point JFK", timezone: "America/New_York" } } : { status: "not_found" },
}));
vi.mock("@/lib/direct/payout-stripe", () => ({
  readPayoutStripeMany: async (ids: string[]) => new Map(ids.map((id) => [id, stripeReads.get(id)])),
}));
vi.mock("@/lib/direct/payout-email", () => ({ sendStatementEmail: email.send }));

import { POST } from "../route";
import { GET } from "../../route";

const okRead = (o: Partial<PayoutStripeRead> = {}): PayoutStripeRead => ({ error: null, amountReceivedCents: 5212, amountRefundedCents: 0, piStatus: "succeeded", disputed: false, disputes: "", feeCents: 181, ...o });

function booking(pi: string, o: Record<string, unknown> = {}) {
  return {
    inventory_source: "direct",
    stripe_payment_intent_id: pi,
    reslab_reservation_number: `TRP-${pi.slice(3).toUpperCase()}`,
    direct_lot_id: "1",
    livemode: true,
    status: "confirmed",
    cancel_state: null,
    cancel_claimed_at: null,
    check_in: "2026-09-20T10:00:00",
    check_out: "2026-09-24T10:00:00",
    location_timezone: "America/New_York",
    lot_snapshot: null,
    subtotal: "39.80",
    tax_total: "6.37",
    triply_service_fee: "5.95",
    protection_plan_wholesale: null,
    ...o,
  };
}
const terms = (pi: string, livemode = true) => ({ stripe_payment_intent_id: pi, direct_lot_id: "1", livemode, partner_share_percent: "80.00", tax_collected_by: "lot" });

const getView = async (month = "2026-09") => {
  const res = await GET(new NextRequest(`https://x.test/api/admin/direct-payouts?lot=1&month=${month}`));
  expect(res.status).toBe(200);
  return res.json();
};
const post = (body: unknown) =>
  POST(new NextRequest("https://x.test/api/admin/direct-payouts/mark-paid", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  db.tables = { bookings: [], direct_booking_terms: [], direct_lot_payout_lines: [], direct_lot_statements: [] };
  db.clearFailures();
  db.rpcCalls = [];
  db.rpcHandlers = { mark_direct_lot_statement_paid: () => ({ data: "st_new", error: null }) };
  stripeReads.clear();
  sentry.captureAPIError.mockReset();
  email.send.mockReset().mockResolvedValue({ outcome: "skipped", reason: "the lot has no billing email on file yet" });
  env.live = true;
  user.current = { email: "tom@triplypro.com" };
  user.admin = true;
  db.seed("bookings", [booking("pi_a"), booking("pi_m", { status: "disputed" })]);
  db.seed("direct_booking_terms", [terms("pi_a"), terms("pi_m")]);
  stripeReads.set("pi_a", okRead()).set("pi_m", okRead());
});

describe("POST /api/admin/direct-payouts/mark-paid", () => {
  it("writes the rebuilt lines through the ledger function, paid_by from the session", async () => {
    const v = await getView();
    const res = await post({ lot: "1", month: "2026-09", viewHash: v.viewHash, expectedTotalCents: 3821 + 1500, decisions: { pi_m: { action: "pay", amountCents: 1500, note: "dispute won" } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ statementId: "st_new", totalCents: 5321, lines: 2, email: { outcome: "skipped" } });
    expect(db.rpcCalls).toHaveLength(1);
    const args = db.rpcCalls[0].args;
    expect(args).toMatchObject({ p_direct_lot_id: "1", p_period_month: "2026-09-01", p_livemode: true, p_total_cents: 5321, p_paid_by: "tom@triplypro.com", p_note: null });
    expect(args.p_lines).toEqual([
      expect.objectContaining({ stripe_payment_intent_id: "pi_a", amount_cents: 3821, decision: "auto" }),
      expect.objectContaining({ stripe_payment_intent_id: "pi_m", amount_cents: 1500, decision: "manual", note: "dispute won" }),
    ]);
    expect(email.send).toHaveBeenCalledWith("st_new", "The Parking Point JFK");
  });

  it("refuses when the statement changed since it was shown (a refund landed)", async () => {
    const v = await getView();
    stripeReads.set("pi_a", okRead({ amountRefundedCents: 5212 }));
    const res = await post({ lot: "1", month: "2026-09", viewHash: v.viewHash, expectedTotalCents: 3821, decisions: { pi_m: { action: "defer" } } });
    expect(res.status).toBe(409);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("refuses a total that differs from what was shown", async () => {
    const v = await getView();
    const res = await post({ lot: "1", month: "2026-09", viewHash: v.viewHash, expectedTotalCents: 9999, decisions: { pi_m: { action: "defer" } } });
    expect(res.status).toBe(409);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("refuses an undecided manual row (422), nothing written", async () => {
    const v = await getView();
    const res = await post({ lot: "1", month: "2026-09", viewHash: v.viewHash, expectedTotalCents: 3821, decisions: {} });
    expect(res.status).toBe(422);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("refuses a live month that is not over", async () => {
    const month = new Date().toISOString().slice(0, 7);
    db.seed("bookings", [booking("pi_now", { check_out: `${month}-01T10:00:00` })]).seed("direct_booking_terms", [terms("pi_now")]);
    stripeReads.set("pi_now", okRead());
    const v = await getView(month);
    const res = await post({ lot: "1", month, viewHash: v.viewHash, expectedTotalCents: 3821, decisions: {} });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("not over");
  });

  it("test mode may pay an open month (staging walk)", async () => {
    env.live = false;
    const month = new Date().toISOString().slice(0, 7);
    db.seed("bookings", [booking("pi_t", { livemode: false, check_out: `${month}-01T10:00:00` })]).seed("direct_booking_terms", [terms("pi_t", false)]);
    stripeReads.set("pi_t", okRead());
    const v = await getView(month);
    const res = await post({ lot: "1", month, viewHash: v.viewHash, expectedTotalCents: 3821, decisions: {} });
    expect(res.status).toBe(200);
    expect(db.rpcCalls[0].args).toMatchObject({ p_livemode: false });
  });

  it("refuses an already-paid month", async () => {
    db.seed("direct_lot_statements", [{ id: "st_1", direct_lot_id: "1", period_month: "2026-09-01", livemode: true, total_cents: 1, paid_at: "x", paid_by: "x", statement_email_id: null, statement_attempts: 0 }]);
    const v = await getView();
    const res = await post({ lot: "1", month: "2026-09", viewHash: v.viewHash, expectedTotalCents: 3821, decisions: { pi_m: { action: "defer" } } });
    expect(res.status).toBe(409);
  });

  it.each([
    ["23505", 409, "Already paid"],
    ["TP001", 409, "A booking changed"],
    ["P0001", 500, "nothing was recorded"],
    ["23503", 500, "nothing was recorded"],
    ["PGRST202", 500, "nothing was recorded"],
    ["", 500, "may already be marked paid"],
  ])("maps a ledger error '%s' to %i (%s)", async (code, status, says) => {
    db.rpcHandlers.mark_direct_lot_statement_paid = () => ({ data: null, error: { code, message: "refused" } });
    const v = await getView();
    const res = await post({ lot: "1", month: "2026-09", viewHash: v.viewHash, expectedTotalCents: 3821, decisions: { pi_m: { action: "defer" } } });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toContain(says);
    expect(email.send).not.toHaveBeenCalled();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(status === 500 ? 1 : 0);
  });

  it("an email failure never fails the recorded payment", async () => {
    email.send.mockRejectedValue(new Error("db down"));
    const v = await getView();
    const res = await post({ lot: "1", month: "2026-09", viewHash: v.viewHash, expectedTotalCents: 3821, decisions: { pi_m: { action: "defer" } } });
    expect(res.status).toBe(200);
    expect((await res.json()).email).toMatchObject({ outcome: "failed" });
    expect(sentry.captureAPIError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ stage: "statement_email" }));
  });

  it("401 without a session, 403 for a non-admin, before any read", async () => {
    user.current = null;
    expect((await post({ lot: "1", month: "2026-09", viewHash: "a".repeat(64), expectedTotalCents: 0, decisions: {} })).status).toBe(401);
    user.current = { email: "someone@example.com" };
    user.admin = false;
    db.log = [];
    expect((await post({ lot: "1", month: "2026-09", viewHash: "a".repeat(64), expectedTotalCents: 0, decisions: {} })).status).toBe(403);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.log).toEqual([]);
  });

  it("refuses a statement with a blocked booking, naming it", async () => {
    db.tables.bookings.push(booking("pi_x"));
    const v = await getView();
    const res = await post({ lot: "1", month: "2026-09", viewHash: v.viewHash, expectedTotalCents: 3821, decisions: { pi_m: { action: "defer" } } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("TRP-X");
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("refuses a hand-typed payout above what the customer paid (\"3821\" for \"38.21\")", async () => {
    const v = await getView();
    const res = await post({ lot: "1", month: "2026-09", viewHash: v.viewHash, expectedTotalCents: 3821 + 382100, decisions: { pi_m: { action: "pay", amountCents: 382100, note: "typo" } } });
    expect(res.status).toBe(422);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it.each([
    [{ lot: "1", month: "2026-9", viewHash: "a".repeat(64), expectedTotalCents: 0, decisions: {} }],
    [{ lot: "x", month: "2026-09", viewHash: "a".repeat(64), expectedTotalCents: 0, decisions: {} }],
    [{ lot: "1", month: "2026-09", viewHash: "nothex", expectedTotalCents: 0, decisions: {} }],
    [{ lot: "1", month: "2026-09", viewHash: "a".repeat(64), expectedTotalCents: 1.5, decisions: {} }],
    [{ lot: "1", month: "2026-09", viewHash: "a".repeat(64), expectedTotalCents: 0, decisions: { pi_a: { action: "pay", amountCents: 1 } } }],
  ])("400 for a malformed body %#", async (body) => {
    expect((await post(body)).status).toBe(400);
  });

  it("404 for an unknown lot", async () => {
    expect((await post({ lot: "7", month: "2026-09", viewHash: "a".repeat(64), expectedTotalCents: 0, decisions: {} })).status).toBe(404);
  });
});
