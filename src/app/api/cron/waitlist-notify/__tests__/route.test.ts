import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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
  // A failAlways left set by one test would silently fail the next.
  db.clearFailures();
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

  it("a SINGLE transient notified_at write failure is retried inline and the row is marked", async () => {
    db.tables.booking_waitlist = [row({ id: "blip", email: "a@example.com" })];
    // One-shot: the retry inside markNotified sees a healthy DB.
    db.failOnce("booking_waitlist", "update", "connection reset", "08006");

    const res = await GET(req());
    const json = await res.json();
    expect(resendSend).toHaveBeenCalledTimes(1);
    // Recorded on the retry — no duplicate email tomorrow, nothing charged
    // to notify_attempts.
    expect(json.sent).toBe(1);
    expect(json.markFailed).toBe(0);
    expect(res.status).toBe(200);
    const marked = db.tables.booking_waitlist.find((r) => r.id === "blip");
    expect(marked?.notified_at).not.toBeNull();
    expect(marked?.notify_attempts).toBe(0);
  });

  it("a SUSTAINED write outage: both the notified_at write and its retry fail, and so does the counter — reported, never silently 'sent'", async () => {
    db.tables.booking_waitlist = [row({ id: "marked_wrong", email: "a@example.com" })];
    // failOnce would only ever prove the optimistic path: the retry, and
    // then recordNotifyFailure's own UPDATE, would both succeed against a DB
    // that is in fact down. This is the case that actually happens.
    db.failAlways("booking_waitlist", "update", "connection reset", "08006");

    const res = await GET(req());
    const json = await res.json();
    // The email genuinely went out.
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(json.sent).toBe(0);
    expect(json.sendFailed).toBe(0);
    expect(json.markFailed).toBe(1);
    // The email went out, but NOTHING could be recorded — neither notified_at
    // nor the attempt counter — so tomorrow re-sends it unchanged and the
    // give-up counter can never retire it. Zero forward progress is a 500,
    // not a green run with `markFailed` buried in the body (pass 5, item 1).
    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(json.unpersisted).toBe(1);
    expect(sentry.captureException).toHaveBeenCalled();
    const noProgress = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("could neither record delivery nor charge")
    );
    expect(noProgress).toBeDefined();
    const stuck = db.tables.booking_waitlist.find((r) => r.id === "marked_wrong");
    // Nothing was written, and nothing PRETENDS to have been: notified_at is
    // still null (the row will be re-sent tomorrow, loudly) and the counter
    // is still 0 because its own write failed too.
    expect(stuck?.notified_at).toBeNull();
    expect(stuck?.notify_attempts).toBe(0);
  });

  it("a row crossing MAX_NOTIFY_ATTEMPTS fires one give-up alarm", async () => {
    db.tables.booking_waitlist = [row({ id: "about_to_give_up", email: "bad@example.com", notify_attempts: 4 })];
    // A suppressed / invalid recipient is a PERMANENT 4xx from Resend — the
    // only kind of failure that charges the counter (a 429/5xx/network error
    // is an outage, never the traveller's fault).
    resendSend.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 422, name: "validation_error", message: "recipient is suppressed" },
    });

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
    // 51 rows, all three days overdue: this run sends the 50 it is allowed to
    // and the 51st is left behind. That is the case `capped` alone cannot
    // describe — every row this run touched succeeded, while a traveller
    // keeps waiting. The overdue check is a SEPARATE query precisely so a row
    // stuck outside the cap still gets caught.
    db.tables.booking_waitlist = Array.from({ length: 51 }, (_, i) =>
      row({ id: `overdue_${i}`, email: `overdue${i}@example.com`, opens_on: threeDaysAgo })
    );

    const res = await GET(req());
    const json = await res.json();
    expect(json.scanned).toBe(50);
    expect(json.sendFailed).toBe(0);
    expect(res.status).toBe(200);

    const backlogCall = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("overdue and still unnotified")
    );
    expect(backlogCall).toBeDefined();
    expect(String(backlogCall?.[0])).toMatch(/^waitlist-notify: 1 row/);
  });

  it("does NOT alarm for an overdue row whose address has unsubscribed", async () => {
    // The pass-4 headline: the first traveller to unsubscribe after their
    // opens_on passed used to make this fire at error level on every run,
    // forever, for a row nobody should ever email — pre-saturating the one
    // backlog signal with false positives.
    db.tables.booking_waitlist = [
      row({
        id: "opted_out_overdue",
        email: "gone@example.com",
        opens_on: threeDaysAgo,
        unsubscribed_at: new Date().toISOString(),
      }),
    ];

    const res = await GET(req());
    expect((await res.json()).scanned).toBe(0);
    const backlogCall = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("overdue and still unnotified")
    );
    expect(backlogCall).toBeUndefined();
  });

  it("does NOT alarm for an overdue row that has already been given up on (it got its own give-up alarm)", async () => {
    db.tables.booking_waitlist = [
      row({ id: "stale", email: "stale@example.com", opens_on: threeDaysAgo, notify_attempts: 5 }),
    ];

    const res = await GET(req());
    const json = await res.json();
    expect(json.scanned).toBe(0);
    expect(res.status).toBe(200);

    const backlogCall = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("overdue and still unnotified")
    );
    expect(backlogCall).toBeUndefined();
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

describe("GET /api/cron/waitlist-notify — a config fault is never a per-row failure", () => {
  const ORIGINAL_SECRET = process.env.WAITLIST_SIGNING_SECRET;
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.WAITLIST_SIGNING_SECRET;
    } else {
      process.env.WAITLIST_SIGNING_SECRET = ORIGINAL_SECRET;
    }
  });

  it("a missing WAITLIST_SIGNING_SECRET → 503 with nothing attempted and no counter touched", async () => {
    // Ship without the var and every row fails identically (each email needs
    // an unsubscribe link). Charged to notify_attempts, five daily runs
    // retire the ENTIRE backlog and the cron then reports a clean
    // `200 {sent: 0, sendFailed: 0}` forever.
    db.tables.booking_waitlist = [
      row({ id: "a", email: "a@example.com" }),
      row({ id: "b", email: "b@example.com" }),
    ];
    delete process.env.WAITLIST_SIGNING_SECRET;

    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(resendSend).not.toHaveBeenCalled();
    expect(sentry.captureException).toHaveBeenCalled();
    for (const r of db.tables.booking_waitlist) {
      expect(r.notify_attempts).toBe(0);
      expect(r.notified_at).toBeNull();
      expect(r.last_notify_error).toBeNull();
    }
  });
});

describe("GET /api/cron/waitlist-notify — whole-batch send failure", () => {
  it("charges no notify_attempts when EVERY send failed (an outage, not N bad addresses)", async () => {
    db.tables.booking_waitlist = [
      row({ id: "a", email: "a@example.com" }),
      row({ id: "b", email: "b@example.com" }),
      row({ id: "c", email: "c@example.com" }),
    ];
    // A rotated RESEND_API_KEY / a Resend outage: not one row's fault, and
    // five such days would otherwise give up on the whole backlog.
    resendSend.mockRejectedValue(new Error("resend down"));

    const res = await GET(req());
    const json = await res.json();
    expect(json.sendFailed).toBe(3);
    expect(json.sent).toBe(0);
    expect(res.status).toBe(500);
    for (const r of db.tables.booking_waitlist) {
      expect(r.notify_attempts).toBe(0);
      expect(r.last_notify_error).toBeNull();
    }
    const outageCall = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("treating as an outage")
    );
    expect(outageCall).toBeDefined();
  });

  it("charges a lone PERMANENTLY-rejected address even though it is the whole batch — the counter is what retires a dead address", async () => {
    db.tables.booking_waitlist = [row({ id: "solo", email: "bad@example.com" })];
    resendSend.mockResolvedValue({
      data: null,
      error: { statusCode: 422, name: "validation_error", message: "hard bounce" },
    });

    const res = await GET(req());
    expect(res.status).toBe(500);
    const failed = db.tables.booking_waitlist.find((r) => r.id === "solo");
    expect(failed?.notify_attempts).toBe(1);
    expect(failed?.last_notify_error).toMatch(/hard bounce/);
    const outageCall = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("treating as an outage")
    );
    expect(outageCall).toBeUndefined();
  });

  it("does NOT charge a lone traveller whose send failed transiently (429 / 5xx / network) — that is an outage of one, not a dead address", async () => {
    db.tables.booking_waitlist = [row({ id: "solo", email: "fine@example.com" })];
    resendSend.mockResolvedValue({
      data: null,
      error: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" },
    });

    const res = await GET(req());
    expect(res.status).toBe(500);
    const r = db.tables.booking_waitlist.find((x) => x.id === "solo");
    expect(r?.notify_attempts).toBe(0);
    expect(r?.last_notify_error).toBeNull();
  });

  it("two permanently-rejected addresses that are the whole batch are charged, not excused as an outage", async () => {
    db.tables.booking_waitlist = [
      row({ id: "dead1", email: "dead1@example.com" }),
      row({ id: "dead2", email: "dead2@example.com" }),
    ];
    resendSend.mockResolvedValue({
      data: null,
      error: { statusCode: 422, name: "validation_error", message: "suppressed" },
    });

    await GET(req());
    for (const r of db.tables.booking_waitlist) expect(r.notify_attempts).toBe(1);
    const outageCall = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("treating as an outage")
    );
    expect(outageCall).toBeUndefined();
  });

  it("reports the standing population of given-up rows on every run", async () => {
    db.tables.booking_waitlist = [
      row({ id: "gone1", email: "gone1@example.com", notify_attempts: 5 }),
      row({ id: "gone2", email: "gone2@example.com", notify_attempts: 7 }),
      row({ id: "ok", email: "ok@example.com" }),
    ];

    const res = await GET(req());
    const json = await res.json();
    expect(json.sent).toBe(1);
    expect(json.abandoned).toBe(2);
    const abandonedCall = sentry.captureMessage.mock.calls.find((call) =>
      String(call[0]).includes("will never be notified")
    );
    expect(abandonedCall).toBeDefined();
  });
});
