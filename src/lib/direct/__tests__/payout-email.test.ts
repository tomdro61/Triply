/**
 * The statement email: who receives it, one send per claimed attempt, and an
 * unknown outcome never reported as sent.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { db, resendSend, sentry, env } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    resendSend: vi.fn(),
    sentry: { captureDirectLotStatement: vi.fn(), captureDirectLotNotice: vi.fn() },
    env: { name: "staging" as string },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send: resendSend } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/env", () => ({ resolveEnv: () => env.name }));

import { sendStatementEmail } from "../payout-email";

const statement = (o: Record<string, unknown> = {}) => ({
  id: "st_1",
  direct_lot_id: "1",
  period_month: "2026-09-01",
  livemode: true,
  total_cents: "3821",
  statement_attempts: 0,
  statement_email_id: null,
  ...o,
});
const line = { statement_id: "st_1", reservation_number: "TRP-AAAA1111", kind: "payout", amount_cents: "3821", decision: "auto", basis: { subtotalCents: 3980, taxCents: 637, shareBp: 8000, taxCollectedBy: "lot", checkOut: "2026-09-24 10:00:00" } };

beforeEach(() => {
  db.tables = { direct_lot_statements: [statement()], direct_lot_payout_lines: [line] };
  db.clearFailures();
  resendSend.mockReset().mockResolvedValue({ data: { id: "em_1" }, error: null });
  sentry.captureDirectLotStatement.mockReset();
  env.name = "staging";
  process.env.DIRECT_LOT_NOTICE_OVERRIDE_TO = "tom@triplypro.com";
});

const LOT_INBOX = ["parkingpointjfk@gmail.com"];
const LOT = { name: "Lot", emails: LOT_INBOX };

describe("sendStatementEmail", () => {
  it("outside production: the override inbox, [TEST], CSV attached, attempt 1 in the key", async () => {
    const r = await sendStatementEmail("st_1", { name: "The Parking Point JFK", emails: LOT_INBOX });
    expect(r).toEqual({ outcome: "sent", emailId: "em_1", to: ["tom@triplypro.com"], test: true });
    const [msg, opts] = resendSend.mock.calls[0];
    expect(msg.to).toEqual(["tom@triplypro.com"]);
    expect(msg.subject).toBe("[TEST] Triply payout statement — The Parking Point JFK — September 2026");
    expect(msg.attachments[0].filename).toBe("triply-statement-1-2026-09.csv");
    expect(String(msg.attachments[0].content)).toContain('"TRP-AAAA1111","2026-09-24","Payout",39.80,80.00,6.37,38.21');
    expect(opts).toEqual({ idempotencyKey: "direct-lot-statement/1/2026-09/live/1" });
    expect(db.tables.direct_lot_statements[0]).toMatchObject({ statement_attempts: 1, statement_email_id: "em_1" });
  });

  it("production + live: the lot's own inbox (one address for bookings and billing), no [TEST]", async () => {
    env.name = "production";
    const r = await sendStatementEmail("st_1", { name: "The Parking Point JFK", emails: LOT_INBOX });
    expect(r).toEqual({ outcome: "sent", emailId: "em_1", to: LOT_INBOX, test: false });
    const [msg, opts] = resendSend.mock.calls[0];
    expect(msg.to).toEqual(LOT_INBOX);
    expect(msg.subject).toBe("Triply payout statement — The Parking Point JFK — September 2026");
    expect(opts).toEqual({ idempotencyKey: "direct-lot-statement/1/2026-09/live/1" });
  });

  it("production + live: a lot with no email on file → not sent, nothing claimed, admin told why", async () => {
    env.name = "production";
    const r = await sendStatementEmail("st_1", { name: "Lot", emails: [] });
    expect(r).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("no email on file") });
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.tables.direct_lot_statements[0].statement_attempts).toBe(0);
  });

  it("production + a test statement still goes to the override inbox", async () => {
    env.name = "production";
    db.tables.direct_lot_statements = [statement({ livemode: false })];
    expect(await sendStatementEmail("st_1", LOT)).toMatchObject({ outcome: "sent", test: true });
    expect(resendSend.mock.calls[0][1]).toEqual({ idempotencyKey: "direct-lot-statement/1/2026-09/test/1" });
  });

  it("no override inbox configured → skipped", async () => {
    process.env.DIRECT_LOT_NOTICE_OVERRIDE_TO = "";
    expect(await sendStatementEmail("st_1", LOT)).toMatchObject({ outcome: "skipped" });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("a re-send is the next attempt (a new key)", async () => {
    db.tables.direct_lot_statements = [statement({ statement_attempts: 1, statement_email_id: "em_0" })];
    await sendStatementEmail("st_1", LOT);
    expect(resendSend.mock.calls[0][1]).toEqual({ idempotencyKey: "direct-lot-statement/1/2026-09/live/2" });
  });

  it("a Resend 5xx is an unknown outcome, not sent", async () => {
    resendSend.mockResolvedValue({ data: null, error: { name: "internal_server_error", message: "x", statusCode: 500 } });
    expect(await sendStatementEmail("st_1", LOT)).toMatchObject({ outcome: "unknown" });
    expect(db.tables.direct_lot_statements[0].statement_email_id).toBeNull();
    expect(sentry.captureDirectLotStatement).toHaveBeenCalledWith(expect.any(Error), { statementId: "st_1", outcome: "unknown" });
  });

  it("a definite refusal is failed", async () => {
    resendSend.mockResolvedValue({ data: null, error: { name: "validation_error", message: "bad to", statusCode: 422 } });
    expect(await sendStatementEmail("st_1", LOT)).toMatchObject({ outcome: "failed" });
  });

  it("a negative total is labelled as owed to Triply", async () => {
    db.tables.direct_lot_statements = [statement({ total_cents: "-3821" })];
    db.tables.direct_lot_payout_lines = [{ ...line, kind: "adjustment", amount_cents: "-3821", decision: "manual" }];
    await sendStatementEmail("st_1", LOT);
    expect(resendSend.mock.calls[0][0].text).toContain("Net balance owed to Triply: $38.21");
  });

  it("two concurrent sends: one email, the other is told it lost", async () => {
    const [a, b] = await Promise.all([sendStatementEmail("st_1", LOT), sendStatementEmail("st_1", LOT)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["busy", "sent"]);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(db.tables.direct_lot_statements[0].statement_attempts).toBe(1);
  });

  it.each([["invalid_idempotent_request"], ["concurrent_idempotent_requests"]])("a 409 about the key (%s) is an unknown outcome, never 'sent'", async (name) => {
    resendSend.mockResolvedValue({ data: null, error: { name, message: "x", statusCode: 409 } });
    expect(await sendStatementEmail("st_1", LOT)).toMatchObject({ outcome: "unknown" });
  });

  it("a send that times out is unknown; one that throws is failed", async () => {
    const { BoundedTimeoutError } = await import("@/lib/utils/bounded");
    resendSend.mockRejectedValueOnce(new BoundedTimeoutError("Resend", 10_000));
    expect(await sendStatementEmail("st_1", LOT)).toMatchObject({ outcome: "unknown" });
    resendSend.mockRejectedValueOnce(new Error("socket"));
    expect(await sendStatementEmail("st_1", LOT)).toMatchObject({ outcome: "failed" });
  });

  it("sent but not stamped: still 'sent', and Sentry hears of it", async () => {
    db.failWhen("direct_lot_statements", "update", (p) => !!p && "statement_email_id" in p, "db down");
    expect(await sendStatementEmail("st_1", LOT)).toMatchObject({ outcome: "sent", emailId: "em_1" });
    expect(sentry.captureDirectLotStatement).toHaveBeenCalledWith(expect.any(Error), { statementId: "st_1", outcome: "failed" });
  });

  it("throws on a statement with no lines rather than send an empty one", async () => {
    db.tables.direct_lot_payout_lines = [];
    await expect(sendStatementEmail("st_1", LOT)).rejects.toThrow("no lines");
    expect(resendSend).not.toHaveBeenCalled();
  });
});
