/**
 * /api/newsletter/__tests__/route.test.ts is the template: another
 * unauthenticated, visitor-facing POST route sharing the same
 * origin/limiter/body-cap/Sentry guards (src/lib/http/origin.ts,
 * src/lib/attribution/limiter.ts) plus a per-email send cap of its own.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { addDays, format, startOfDay, subDays } from "date-fns";
import { MAX_ADVANCE_BOOKING_DAYS } from "@/lib/booking-window";

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

import { POST, __resetWaitlistRouteTelemetryForTests } from "../route";
import { __resetWaitlistRateLimitForTests } from "@/lib/attribution/limiter";

const HOST = "www.triplypro.com";
const MAX_DATE = addDays(startOfDay(new Date()), MAX_ADVANCE_BOOKING_DAYS);
const fmt = (d: Date) => format(d, "yyyy-MM-dd");

function post(
  body: unknown,
  opts: { headers?: Record<string, string>; raw?: string } = {}
) {
  const text = opts.raw ?? JSON.stringify(body);
  return new NextRequest(`https://${HOST}/api/waitlist`, {
    method: "POST",
    headers: {
      host: HOST,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "203.0.113.7",
      ...opts.headers,
    },
    body: text,
  });
}

function tripAt(date: Date, email = "a@example.com") {
  return { email, airportCode: "abe", wantedCheckin: fmt(date) };
}

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  __resetWaitlistRateLimitForTests();
  __resetWaitlistRouteTelemetryForTests();
  db.tables = { booking_waitlist: [] };
  db.log = [];
});

describe("POST /api/waitlist — origin gate", () => {
  it("cross-origin request → 403, nothing written, no email", async () => {
    const res = await POST(
      post(tripAt(addDays(MAX_DATE, 5)), { headers: { "sec-fetch-site": "cross-site" } })
    );
    expect(res.status).toBe(403);
    expect(db.tables.booking_waitlist).toHaveLength(0);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe("POST /api/waitlist — limits", () => {
  it("a body over 2048 bytes → 413", async () => {
    const res = await POST(
      post(null, { raw: JSON.stringify({ ...tripAt(addDays(MAX_DATE, 5)), page: "x".repeat(3000) }) })
    );
    expect(res.status).toBe(413);
  });

  it("6th request from the same IP inside a minute → 429; a different IP is unaffected", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await POST(post(tripAt(addDays(MAX_DATE, 5), `a${i}@example.com`)));
      expect(res.status).toBe(200);
    }
    expect((await POST(post(tripAt(addDays(MAX_DATE, 5), "a6@example.com")))).status).toBe(429);
    expect(
      (
        await POST(
          post(tripAt(addDays(MAX_DATE, 5), "b@example.com"), {
            headers: { "x-forwarded-for": "198.51.100.9" },
          })
        )
      ).status
    ).toBe(200);
  });

  it("wantedCheckin more than 730 days out → 400", async () => {
    const res = await POST(post(tripAt(addDays(startOfDay(new Date()), 731))));
    expect(res.status).toBe(400);
    expect(db.tables.booking_waitlist).toHaveLength(0);
  });
});

describe("POST /api/waitlist — validation", () => {
  it("disabled/unknown airport code → 400, nothing written", async () => {
    const res = await POST(post({ ...tripAt(addDays(MAX_DATE, 5)), airportCode: "zzz" }));
    expect(res.status).toBe(400);
    expect(db.tables.booking_waitlist).toHaveLength(0);
  });

  it("invalid email → 400", async () => {
    const res = await POST(post({ ...tripAt(addDays(MAX_DATE, 5)), email: "not-an-email" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/waitlist — booking-window boundary", () => {
  it("maxDate - 1 day (clearly bookable now) → 400, nothing written", async () => {
    const res = await POST(post(tripAt(subDays(MAX_DATE, 1))));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/already open/i);
    expect(db.tables.booking_waitlist).toHaveLength(0);
  });

  it("exactly maxDate (the ≤1-day straddle) → accepted as a waitlist entry", async () => {
    const res = await POST(post(tripAt(MAX_DATE)));
    expect(res.status).toBe(200);
    expect(db.tables.booking_waitlist).toHaveLength(1);
  });

  it("maxDate + 1 day → accepted as a waitlist entry", async () => {
    const res = await POST(post(tripAt(addDays(MAX_DATE, 1))));
    expect(res.status).toBe(200);
    expect(db.tables.booking_waitlist).toHaveLength(1);
  });
});

describe("POST /api/waitlist — new signup", () => {
  it("valid new entry writes a row and sends one confirmation email", async () => {
    const res = await POST(post(tripAt(addDays(MAX_DATE, 10))));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.opensOn).toBe(fmt(subDays(addDays(MAX_DATE, 10), MAX_ADVANCE_BOOKING_DAYS)));

    expect(db.tables.booking_waitlist).toHaveLength(1);
    expect(db.tables.booking_waitlist[0].email).toBe("a@example.com");
    expect(resendSend).toHaveBeenCalledTimes(1);
    // Carries a List-Unsubscribe header per the reviewer's opt-out requirement.
    const sendArgs = resendSend.mock.calls[0][0];
    expect(sendArgs.headers["List-Unsubscribe"]).toMatch(/\/api\/waitlist\/unsubscribe\?/);
  });
});

describe("POST /api/waitlist — duplicate trip", () => {
  it("23505 unique-violation on insert → 200, no second confirmation email", async () => {
    db.failOnce("booking_waitlist", "insert", "duplicate key value", "23505");
    const res = await POST(post(tripAt(addDays(MAX_DATE, 10))));
    expect(res.status).toBe(200);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe("POST /api/waitlist — per-email send cap", () => {
  it("4th distinct trip from the same address in 24h is written but not sent", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await POST(
        post({
          email: "capped@example.com",
          airportCode: "abe",
          wantedCheckin: fmt(addDays(MAX_DATE, 10 + i)),
        })
      );
      expect(res.status).toBe(200);
    }
    expect(resendSend).toHaveBeenCalledTimes(3);

    const res = await POST(
      post({
        email: "capped@example.com",
        airportCode: "abe",
        wantedCheckin: fmt(addDays(MAX_DATE, 20)),
      })
    );
    expect(res.status).toBe(200);
    // The row is still written — it's still a real demand signal.
    expect(
      db.tables.booking_waitlist.filter((r) => r.email === "capped@example.com")
    ).toHaveLength(4);
    // But the 4th send never went out.
    expect(resendSend).toHaveBeenCalledTimes(3);
  });
});
