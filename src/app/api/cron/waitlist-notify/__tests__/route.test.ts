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
}));

import { GET } from "../route";

const CRON_SECRET = process.env.CRON_SECRET as string;
const today = format(new Date(), "yyyy-MM-dd");
const yesterday = format(subDays(new Date(), 1), "yyyy-MM-dd");
const tomorrow = format(subDays(new Date(), -1), "yyyy-MM-dd");

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
      { id: "due_today", email: "a@example.com", airport_code: "ABE", wanted_checkin: "2027-01-10", wanted_checkout: null, opens_on: today, notified_at: null, unsubscribed_at: null },
      { id: "due_yesterday", email: "b@example.com", airport_code: "ABE", wanted_checkin: "2027-01-10", wanted_checkout: null, opens_on: yesterday, notified_at: null, unsubscribed_at: null },
      { id: "not_yet", email: "c@example.com", airport_code: "ABE", wanted_checkin: "2027-03-10", wanted_checkout: null, opens_on: tomorrow, notified_at: null, unsubscribed_at: null },
      { id: "already_sent", email: "d@example.com", airport_code: "ABE", wanted_checkin: "2027-01-10", wanted_checkout: null, opens_on: today, notified_at: new Date().toISOString(), unsubscribed_at: null },
      { id: "opted_out", email: "e@example.com", airport_code: "ABE", wanted_checkin: "2027-01-10", wanted_checkout: null, opens_on: today, notified_at: null, unsubscribed_at: new Date().toISOString() },
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

  it("one send failure does not stop the rest of the batch, and is captured", async () => {
    db.tables.booking_waitlist = [
      { id: "fails", email: "bad@example.com", airport_code: "ABE", wanted_checkin: "2027-01-10", wanted_checkout: null, opens_on: today, notified_at: null, unsubscribed_at: null },
      { id: "ok", email: "good@example.com", airport_code: "ABE", wanted_checkin: "2027-01-10", wanted_checkout: null, opens_on: today, notified_at: null, unsubscribed_at: null },
    ];
    resendSend.mockRejectedValueOnce(new Error("resend down"));

    const res = await GET(req());
    const json = await res.json();
    expect(json.sent).toBe(1);
    expect(json.failed).toBe(1);
    expect(sentry.captureException).toHaveBeenCalled();
    expect(db.tables.booking_waitlist.find((r) => r.id === "ok")?.notified_at).not.toBeNull();
    expect(db.tables.booking_waitlist.find((r) => r.id === "fails")?.notified_at).toBeNull();
  });
});
