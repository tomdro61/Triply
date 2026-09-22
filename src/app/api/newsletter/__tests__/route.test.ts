/**
 * /api/attribution/__tests__/route.test.ts is the near-exact template: this
 * is the second unauthenticated, visitor-facing POST route sharing the same
 * origin/limiter/body-cap/Sentry guards (src/lib/http/origin.ts,
 * src/lib/attribution/limiter.ts).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

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

import { POST, __resetNewsletterRouteTelemetryForTests } from "../route";
import { __resetNewsletterRateLimitForTests } from "@/lib/attribution/limiter";

const HOST = "www.triplypro.com";

function post(
  body: unknown,
  opts: { headers?: Record<string, string>; raw?: string } = {}
) {
  const text = opts.raw ?? JSON.stringify(body);
  return new NextRequest(`https://${HOST}/api/newsletter`, {
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

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  __resetNewsletterRateLimitForTests();
  __resetNewsletterRouteTelemetryForTests();
  db.tables = { newsletter_subscribers: [], promo_codes: [] };
  db.log = [];
});

describe("POST /api/newsletter — origin gate", () => {
  it("cross-origin request → 403, no promo code minted, one Sentry event", async () => {
    const res = await POST(
      post({ email: "a@example.com" }, { headers: { "sec-fetch-site": "cross-site" } })
    );
    expect(res.status).toBe(403);
    expect(db.tables.promo_codes).toHaveLength(0);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/newsletter — limits", () => {
  it("a body over 2048 bytes → 413", async () => {
    const res = await POST(
      post(null, { raw: JSON.stringify({ email: "a@example.com", slug: "x".repeat(3000) }) })
    );
    expect(res.status).toBe(413);
  });

  it("6th request from the same IP inside a minute → 429; a different IP is unaffected", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await POST(post({ email: `a${i}@example.com` }))).status).toBe(200);
    }
    expect((await POST(post({ email: "a6@example.com" }))).status).toBe(429);
    expect(
      (await POST(post({ email: "b@example.com" }, { headers: { "x-forwarded-for": "198.51.100.9" } }))).status
    ).toBe(200);
  });
});

describe("POST /api/newsletter — validation", () => {
  it("bad airport code → 400, nothing written", async () => {
    const res = await POST(post({ email: "a@example.com", airportCode: "ZZZ" }));
    expect(res.status).toBe(400);
    expect(db.tables.newsletter_subscribers).toHaveLength(0);
  });

  it("invalid email → 400", async () => {
    expect((await POST(post({ email: "not-an-email" }))).status).toBe(400);
  });
});

describe("POST /api/newsletter — new signup", () => {
  it("valid new signup mints a code, records source, sends the email", async () => {
    const res = await POST(
      post({ email: "New@Example.com", source: "blog", airportCode: "abe", slug: "abe-parking" })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ success: true });
    expect(json.alreadySubscribed).toBeUndefined();

    expect(db.tables.promo_codes).toHaveLength(1);
    expect(db.tables.newsletter_subscribers).toHaveLength(1);
    const sub = db.tables.newsletter_subscribers[0];
    expect(sub.email).toBe("new@example.com");
    expect(sub.source).toBe("blog");
    expect(sub.airport_code).toBe("ABE");
    expect(sub.page).toBe("abe-parking");
    expect(resendSend).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/newsletter — already subscribed", () => {
  it("existing subscriber with an unexpired, unused code: no new code, no email, alreadySubscribed true", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString();
    db.tables.promo_codes.push({
      id: "promo_1",
      active: true,
      current_uses: 0,
      max_uses: 1,
      expires_at: future,
    });
    db.tables.newsletter_subscribers.push({
      id: "sub_1",
      email: "existing@example.com",
      unsubscribed_at: null,
      promo_code_id: "promo_1",
      source: null,
    });

    const res = await POST(post({ email: "existing@example.com", source: "blog" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.alreadySubscribed).toBe(true);
    expect(json.message).toMatch(/already subscribed/i);

    expect(db.tables.promo_codes).toHaveLength(1);
    expect(resendSend).not.toHaveBeenCalled();
    // First-touch attribution still recorded for the existing subscriber.
    expect(db.tables.newsletter_subscribers[0].source).toBe("blog");
  });

  it("existing subscriber with an expired code gets a fresh one re-sent", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    db.tables.promo_codes.push({
      id: "promo_2",
      active: true,
      current_uses: 0,
      max_uses: 1,
      expires_at: past,
    });
    db.tables.newsletter_subscribers.push({
      id: "sub_2",
      email: "stale@example.com",
      unsubscribed_at: null,
      promo_code_id: "promo_2",
      source: "homepage",
    });

    const res = await POST(post({ email: "stale@example.com" }));
    const json = await res.json();
    expect(json.alreadySubscribed).toBe(true);
    expect(db.tables.promo_codes).toHaveLength(2);
    expect(resendSend).toHaveBeenCalledTimes(1);
    // First-touch: an already-set source is never overwritten.
    expect(db.tables.newsletter_subscribers[0].source).toBe("homepage");
  });
});
