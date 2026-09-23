import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { format, subDays } from "date-fns";

const { db, sentry, resendSend } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    sentry: { captureMessage: vi.fn(), withScope: vi.fn(), captureException: vi.fn() },
    resendSend: vi.fn().mockResolvedValue({ data: { id: "email_1" }, error: null }),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/resend/client", () => ({
  resend: { emails: { send: resendSend } },
  FROM_EMAIL: "Triply <bookings@triplypro.com>",
}));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: sentry.captureMessage,
  captureException: sentry.captureException,
  withScope: (fn: (scope: unknown) => void) => {
    sentry.withScope();
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn() });
  },
  flush: vi.fn().mockResolvedValue(true),
}));

import { GET } from "../route";

const CRON_SECRET = process.env.CRON_SECRET as string;
const today = format(new Date(), "yyyy-MM-dd");
const yesterday = format(subDays(new Date(), 1), "yyyy-MM-dd");
const tomorrow = format(subDays(new Date(), -1), "yyyy-MM-dd");
const threeDaysAgo = format(subDays(new Date(), 3), "yyyy-MM-dd");

/** A row with sensible defaults for the columns every test doesn't care
 *  about, so each test only spells out what it's actually exercising. */
function row(overrides: Record<string, unknown>) {
  return {
    id: "row",
    email: "a@example.com",
    airport_code: "ABE",
    wanted_checkin: "2027-01-10",
    wanted_checkout: null,
    opens_on: today,
    notified_at: null,
    unsubscribed_at: null,
    notify_attempts: 0,
    last_notify_error: null,
    ...overrides,
  };
}

function req(headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  return new NextRequest("https://www.triplypro.com/api/cron/waitlist-notify", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  db.tables = { booking_waitlist: [] };
  db.log = [];
});

describe("GET /api/cron/waitlist-notify — auth", () => {
  it("missing/wrong bearer → 401, nothing sent", async () => {
    expect((await GET(req({}))).status).toBe(401);
    expect((await GET(req({ authorization: "Bearer wrong" }))).status).toBe(401);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/waitlist-notify — selection", () => {
  it("sends for opens_on <= today, unnotified, not unsubscribed; skips the rest", async () => {
    db.tables.booking_waitlist = [
      row({ id: "due_today", email: "a@example.com", opens_on: today }),
      row({ id: "due_yesterday", email: "b@example.com", opens_on: yesterday }),
      row({ id: "not_yet", email: "c@example.com", wanted_checkin: "2027-03-10", opens_on: tomorrow }),
      row({ id: "already_sent", email: "d@example.com", opens_on: today, notified_at: new Date().toISOString() }),
      row({ id: "opted_out", email: "e@example.com", opens_on: today, unsubscribed_at: new Date().toISOString() }),
    ];

    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sent).toBe(2);
    expect(resendSend).toHaveBeenCalledTimes(2);

    const notified = db.tables.booking_waitlist.filter((r) => r.notified_at !== null);
    expect(notified.map((r) => r.id).sort()).toEqual(["already_sent", "due_today", "due_yesterday"].sort());
    expect(db.tables.booking_waitlist.find((r) => r.id === "not_yet")?.notified_at).toBeNull();
    expect(db.tables.booking_waitlist.find((r) => r.id === "opted_out")?.notified_at).toBeNull();
  });

  it("processes the oldest opens_on first even when rows are seeded in a different order (order() must actually order)", async () => {
    // Seeded newest-opens_on-first, deliberately the opposite of insertion
    // order a naive/no-op `.order()` fake would have preserved.
    db.tables.booking_waitlist = [
      row({ id: "newest", email: "c@example.com", opens_on: today }),
      row({ id: "oldest", email: "a@example.com", opens_on: format(subDays(new Date(), 5), "yyyy-MM-dd") }),
      row({ id: "middle", email: "b@example.com", opens_on: yesterday }),
    ];

    await GET(req());

    // All three are within budget/cap here, so this alone wouldn't catch a
    // broken order() — the real assertion is the SEND order below.
    const sendOrder = resendSend.mock.calls.map((call) => call[0].to[0]);
    expect(sendOrder).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
  });

  it("does not re-attempt a row that has already hit MAX_NOTIFY_ATTEMPTS", async () => {
    db.tables.booking_waitlist = [
      row({ id: "given_up", email: "poison@example.com", opens_on: yesterday, notify_attempts: 5 }),
      row({ id: "fresh", email: "ok@example.com", opens_on: today, notify_attempts: 0 }),
    ];

    const res = await GET(req());
    const json = await res.json();
    expect(json.scanned).toBe(1);
    expect(json.sent).toBe(1);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(resendSend.mock.calls[0][0].to).toEqual(["ok@example.com"]);
  });

  it("one send failure (thrown) does not stop the rest of the batch, and is captured", async () => {
    db.tables.booking_waitlist = [
      row({ id: "fails", email: "bad@example.com" }),
      row({ id: "ok", email: "good@example.com" }),
    ];
    resendSend.mockRejectedValueOnce(new Error("resend down"));

    const res = await GET(req());
    const json = await res.json();
    expect(json.sent).toBe(1);
    expect(json.sendFailed).toBe(1);
    expect(json.markFailed).toBe(0);
    expect(sentry.captureException).toHaveBeenCalled();
    expect(db.tables.booking_waitlist.find((r) => r.id === "ok")?.notified_at).not.toBeNull();
    const failedRow = db.tables.booking_waitlist.find((r) => r.id === "fails");
    expect(failedRow?.notified_at).toBeNull();
    // notify_attempts incremented and the error recorded, so this row can
    // eventually be given up on instead of retried forever.
    expect(failedRow?.notify_attempts).toBe(1);
    expect(failedRow?.last_notify_error).toMatch(/resend down/);
  });

  it("resend@6.9.1 never throws — a { data: null, error } result must be treated as a failure, not a success", async () => {
    db.tables.booking_waitlist = [row({ id: "rejected", email: "bad@example.com" })];
    resendSend.mockResolvedValueOnce({ data: null, error: { statusCode: 429, message: "rate limited", name: "rate_limit_exceeded" } });

    const res = await GET(req());
    const json = await res.json();
    expect(json.sent).toBe(0);
    expect(json.sendFailed).toBe(1);
    // The row must stay retryable: notified_at IS NULL is the only retry
    // predicate, and it must NOT be written when the send itself failed.
    expect(db.tables.booking_waitlist.find((r) => r.id === "rejected")?.notified_at).toBeNull();
    expect(sentry.captureException).toHaveBeenCalled();
    // All rows in this run failed to SEND — loud alarm, not a quiet 200.
    expect(res.status).toBe(500);
    expect(sentry.captureMessage).toHaveBeenCalled();
  });

  it("a mark_notified failure is NOT counted as a send failure and does not 500 the run", async () => {
    db.tables.booking_waitlist = [row({ id: "marked_wrong", email: "a@example.com" })];
    db.failOnce("booking_waitlist", "update", "connection reset", "08006");

    const res = await GET(req());
    const json = await res.json();
    // The email genuinely went out.
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(json.sent).toBe(0);
    expect(json.sendFailed).toBe(0);
    expect(json.markFailed).toBe(1);
    // sendFailed (0) !== scanned (1) — the batch did not entirely fail to
    // SEND, even though bookkeeping failed, so this must stay a 200.
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("a row crossing MAX_NOTIFY_ATTEMPTS fires one give-up alarm", async () => {
    db.tables.booking_waitlist = [row({ id: "about_to_give_up", email: "bad@example.com", notify_attempts: 4 })];
    resendSend.mockRejectedValueOnce(new Error("hard bounce"));

    await GET(req());

    const failedRow = db.tables.booking_waitlist.find((r) => r.id === "about_to_give_up");
    expect(failedRow?.notify_attempts).toBe(5);
    const giveUpCall = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("will no longer be retried")
    );
    expect(giveUpCall).toBeDefined();
  });

  it("the cap alarm fires when the run hits MAX_ROWS_PER_RUN even with zero failures", async () => {
    db.tables.booking_waitlist = Array.from({ length: 50 }, (_, i) =>
      row({ id: `row_${i}`, email: `ok${i}@example.com`, opens_on: today })
    );

    const res = await GET(req());
    const json = await res.json();
    expect(json.sendFailed).toBe(0);
    expect(json.markFailed).toBe(0);
    expect(json.capped).toBe(true);
    expect(res.status).toBe(200);
    const cappedCall = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("was capped")
    );
    expect(cappedCall).toBeDefined();
  });

  it("alarms when rows are more than 2 days overdue and still unnotified, even when this run's own batch is clean", async () => {
    db.tables.booking_waitlist = [
      // Already given up on (notify_attempts at the cap) — invisible to the
      // main select's `.lt("notify_attempts", MAX_NOTIFY_ATTEMPTS)`, so this
      // run's own batch below sends 0/0/0 cleanly. The overdue check is a
      // SEPARATE, unfiltered query precisely so a permanently-stuck row like
      // this still gets caught instead of going quiet forever.
      row({ id: "stale", email: "stale@example.com", opens_on: threeDaysAgo, notify_attempts: 5 }),
    ];

    const res = await GET(req());
    const json = await res.json();
    expect(json.scanned).toBe(0);
    expect(res.status).toBe(200);

    const backlogCall = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("overdue and still unnotified")
    );
    expect(backlogCall).toBeDefined();
  });

  it("the notification link always includes a checkout date, even with no wanted_checkout on file", async () => {
    db.tables.booking_waitlist = [row({ id: "no_checkout", email: "a@example.com" })];
    await GET(req());
    const sendArgs = resendSend.mock.calls[0][0];
    expect(sendArgs.html).toMatch(/checkout=2027-01-17/);
  });

  it("uses wanted_checkout when the traveller gave one", async () => {
    db.tables.booking_waitlist = [row({ id: "with_checkout", email: "a@example.com", wanted_checkout: "2027-01-14" })];
    await GET(req());
    const sendArgs = resendSend.mock.calls[0][0];
    expect(sendArgs.html).toMatch(/checkout=2027-01-14/);
  });

  it("carries List-Unsubscribe-Post: List-Unsubscribe=One-Click alongside List-Unsubscribe", async () => {
    db.tables.booking_waitlist = [row({ id: "row_1", email: "a@example.com" })];
    await GET(req());
    const sendArgs = resendSend.mock.calls[0][0];
    expect(sendArgs.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});
