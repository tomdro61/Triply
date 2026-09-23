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

import {
  POST,
  __resetNewsletterRouteTelemetryForTests,
  SUCCESS_MESSAGE,
} from "../route";
import {
  __resetNewsletterRateLimitForTests,
  __resetNewsletterRequestRateLimitForTests,
} from "@/lib/attribution/limiter";

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
  __resetNewsletterRequestRateLimitForTests();
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

  it("16th request from the same IP inside a minute → 429 with Retry-After; a different IP is unaffected", async () => {
    for (let i = 0; i < 15; i++) {
      expect((await POST(post({ email: `a${i}@example.com` }))).status).toBe(200);
    }
    const limited = await POST(post({ email: "a16@example.com" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(
      (await POST(post({ email: "b@example.com" }, { headers: { "x-forwarded-for": "198.51.100.9" } }))).status
    ).toBe(200);
  });

  it("already-subscribed lookups don't burn the mint quota, but ARE bounded by the request-level limiter", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString();
    db.tables.promo_codes.push({
      id: "promo_quota",
      active: true,
      current_uses: 0,
      max_uses: 1,
      expires_at: future,
    });
    db.tables.newsletter_subscribers.push({
      id: "sub_quota",
      email: "quota@example.com",
      unsubscribed_at: null,
      promo_code_id: "promo_quota",
      source: null,
      // Recently sent, so these lookups hit the plain "already subscribed"
      // response, not the resend path — isolates the limiter behaviour this
      // test is actually about.
      welcome_sent_at: new Date().toISOString(),
    });

    // Pass-3 review: this used to assert 20 straight 200s to "prove" the
    // mint-only quota didn't charge these lookups — but that quota not being
    // charged is exactly the bug (unbounded requests from a public endpoint).
    // The request-level limiter (60/min/IP) now bounds this instead: 60
    // succeed, the 61st is 429.
    for (let i = 0; i < 60; i++) {
      const res = await POST(post({ email: "quota@example.com" }));
      expect(res.status).toBe(200);
    }
    const limited = await POST(post({ email: "quota@example.com" }));
    expect(limited.status).toBe(429);

    // The mint-specific 15/min quota is a separate bucket and is untouched by
    // these lookups — a genuinely new signup from the same IP would still hit
    // the REQUEST limiter first (also exhausted here), but from a fresh IP it
    // mints normally, proving the mint quota itself was never charged.
    const fromAnotherIp = await POST(
      post({ email: "newsignup@example.com" }, { headers: { "x-forwarded-for": "198.51.100.42" } })
    );
    expect(fromAnotherIp.status).toBe(200);
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
    // Pass 4: identical body shape to the already-subscribed cases — no
    // alreadySubscribed flag, same message.
    expect(json).toEqual({ success: true, message: SUCCESS_MESSAGE });

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
  it("existing subscriber with an unexpired, unused code: no new code, no email, identical body to a new signup", async () => {
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
      // Confirmed-sent recently — inside the resend cooldown, so this is the
      // plain "already subscribed" response, not a resend.
      welcome_sent_at: new Date().toISOString(),
    });

    const res = await POST(post({ email: "existing@example.com", source: "blog" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    // Same status and body as a brand-new signup — the response itself must
    // not reveal that this address was already on the list.
    expect(json).toEqual({ success: true, message: SUCCESS_MESSAGE });

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

    const res = await POST(post({ email: "stale@example.com", source: "blog" }));
    const json = await res.json();
    expect(json).toEqual({ success: true, message: SUCCESS_MESSAGE });
    expect(db.tables.promo_codes).toHaveLength(2);
    expect(resendSend).toHaveBeenCalledTimes(1);
    // First-touch: an already-set source is never overwritten, even though
    // this request sent a different one.
    expect(db.tables.newsletter_subscribers[0].source).toBe("homepage");
  });

  it("a redeemed code (current_uses > 0) is never re-minted, even if it has also expired", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    db.tables.promo_codes.push({
      id: "promo_used",
      active: true,
      current_uses: 1,
      max_uses: 1,
      expires_at: past,
    });
    db.tables.newsletter_subscribers.push({
      id: "sub_used",
      email: "redeemed@example.com",
      unsubscribed_at: null,
      promo_code_id: "promo_used",
      source: null,
    });

    const res = await POST(post({ email: "redeemed@example.com" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    // Same body as every other success path — see the SUCCESS_MESSAGE
    // comment in route.ts. What actually differs (no mint, no send) is only
    // observable via the DB/Resend mocks below, never via the response.
    expect(json).toEqual({ success: true, message: SUCCESS_MESSAGE });

    // No fresh code minted, no mail sent — the one-time discount stays used.
    expect(db.tables.promo_codes).toHaveLength(1);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("welcome_sent_at within 7 days blocks a re-mint even for a never-used, expired code", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const recentlySent = new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString();
    db.tables.promo_codes.push({
      id: "promo_cooldown",
      active: true,
      current_uses: 0,
      max_uses: 1,
      expires_at: past,
    });
    db.tables.newsletter_subscribers.push({
      id: "sub_cooldown",
      email: "cooldown@example.com",
      unsubscribed_at: null,
      promo_code_id: "promo_cooldown",
      source: null,
      welcome_sent_at: recentlySent,
    });

    const res = await POST(post({ email: "cooldown@example.com" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, message: SUCCESS_MESSAGE });

    expect(db.tables.promo_codes).toHaveLength(1);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("welcome_sent_at outside the 7-day cooldown allows a re-mint of a never-used, expired code", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const longAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 8).toISOString();
    db.tables.promo_codes.push({
      id: "promo_stale_cooldown",
      active: true,
      current_uses: 0,
      max_uses: 1,
      expires_at: past,
    });
    db.tables.newsletter_subscribers.push({
      id: "sub_stale_cooldown",
      email: "stalecooldown@example.com",
      unsubscribed_at: null,
      promo_code_id: "promo_stale_cooldown",
      source: null,
      welcome_sent_at: longAgo,
    });

    const res = await POST(post({ email: "stalecooldown@example.com" }));
    expect(res.status).toBe(200);
    expect(db.tables.promo_codes).toHaveLength(2);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(db.tables.newsletter_subscribers[0].welcome_sent_at).not.toBe(longAgo);
  });
});

describe("POST /api/newsletter — resubscribe", () => {
  it("a previously-unsubscribed address re-subscribing clears unsubscribed_at, mints a new code, and sends mail", async () => {
    db.tables.newsletter_subscribers.push({
      id: "sub_resub",
      email: "backagain@example.com",
      unsubscribed_at: new Date().toISOString(),
      promo_code_id: null,
      source: null,
    });

    const res = await POST(post({ email: "backagain@example.com", source: "blog" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, message: SUCCESS_MESSAGE });

    const sub = db.tables.newsletter_subscribers[0];
    expect(sub.unsubscribed_at).toBeNull();
    expect(sub.promo_code_id).toBeTruthy();
    expect(sub.welcome_sent_at).toBeTruthy();
    expect(resendSend).toHaveBeenCalledTimes(1);
    // Pass-5 regression guard: attribution used to be written inside the
    // new-insert branch only, so a returning subscriber recorded nothing —
    // and this test could not see it, because it sent no source at all.
    expect(sub.source).toBe("blog");
  });

  it("a failed resubscribe UPDATE returns 503 and is reported to Sentry, not a false success", async () => {
    db.tables.newsletter_subscribers.push({
      id: "sub_resub_fail",
      email: "failresub@example.com",
      unsubscribed_at: new Date().toISOString(),
      promo_code_id: null,
      source: null,
    });
    db.failOnce("newsletter_subscribers", "update", "connection reset", "08006");

    const res = await POST(post({ email: "failresub@example.com" }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(sentry.captureException).toHaveBeenCalled();
    // The code minted before the failed UPDATE is best-effort cleaned up, not
    // left behind as an orphaned live 10% code.
    expect(db.tables.promo_codes).toHaveLength(0);
  });
});

describe("POST /api/newsletter — mint failure is honest", () => {
  it("a promo-code insert failure returns 503 (not a false 200 'check your email'), and is reported to Sentry", async () => {
    db.failOnce("promo_codes", "insert", "RLS violation", "42501");

    const res = await POST(post({ email: "mintfail@example.com" }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(json.success).toBeUndefined();
    expect(sentry.captureException).toHaveBeenCalled();
    expect(db.tables.newsletter_subscribers).toHaveLength(0);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("a subscriber-insert failure (e.g. race on the email UNIQUE constraint) is reported to Sentry", async () => {
    db.failOnce("newsletter_subscribers", "insert", "duplicate key value", "23505");

    const res = await POST(post({ email: "raced@example.com" }));
    // 503 like every other write failure on this route — a 23505 race is
    // retryable, and the old 500 + its own copy was the one inconsistent
    // failure shape.
    expect(res.status).toBe(503);
    expect(sentry.captureException).toHaveBeenCalled();
    // The code minted before the failed insert is best-effort cleaned up,
    // not left behind as an orphaned live 10% code.
    expect(db.tables.promo_codes).toHaveLength(0);
  });
});

describe("POST /api/newsletter — Resend errors are never a silent success", () => {
  it("resend.emails.send() returning { data: null, error } downgrades the message and reports to Sentry, but keeps the subscriber", async () => {
    resendSend.mockResolvedValueOnce({
      data: null,
      error: { name: "application_error", message: "Unverified domain" },
    });

    const res = await POST(post({ email: "bademail@example.com" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, message: SUCCESS_MESSAGE });
    expect(sentry.captureException).toHaveBeenCalled();

    // The subscriber + promo code still exist — a mail outage shouldn't
    // discard a genuine signup.
    expect(db.tables.newsletter_subscribers).toHaveLength(1);
    expect(db.tables.promo_codes).toHaveLength(1);
  });

  it("resend.emails.send() throwing (transport failure) is also caught and reported, not silently swallowed", async () => {
    resendSend.mockRejectedValueOnce(new Error("fetch failed"));

    const res = await POST(post({ email: "throwsemail@example.com" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, message: SUCCESS_MESSAGE });
    expect(sentry.captureException).toHaveBeenCalled();
  });
});

describe("POST /api/newsletter — a failed welcome email never locks the subscriber out", () => {
  it("a Resend failure on first signup does not stamp welcome_sent_at; retrying resends the SAME code and stamps it only once delivered", async () => {
    resendSend.mockResolvedValueOnce({
      data: null,
      error: { name: "application_error", message: "Unverified domain" },
    });

    const first = await POST(post({ email: "retryme@example.com" }));
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson).toEqual({ success: true, message: SUCCESS_MESSAGE });

    expect(db.tables.promo_codes).toHaveLength(1);
    const mintedCode = db.tables.promo_codes[0].code as string;
    const subAfterFailure = db.tables.newsletter_subscribers[0];
    expect(subAfterFailure.welcome_sent_at).toBeFalsy();

    // Retry: the code is still active/unused/unexpired, and welcome_sent_at
    // was never stamped (no confirmed send), so the cooldown doesn't apply —
    // the route must resend the EXISTING code rather than dead-ending the
    // subscriber with "check your email" and no way to ever get it resent.
    resendSend.mockResolvedValueOnce({ data: { id: "email_retry" }, error: null });
    const second = await POST(post({ email: "retryme@example.com" }));
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson).toEqual({ success: true, message: SUCCESS_MESSAGE });

    // No duplicate mint — the same code is reused.
    expect(db.tables.promo_codes).toHaveLength(1);
    expect(resendSend).toHaveBeenLastCalledWith(
      expect.objectContaining({ html: expect.stringContaining(mintedCode) })
    );

    // welcome_sent_at is now stamped, since this send was confirmed.
    expect(db.tables.newsletter_subscribers[0].welcome_sent_at).toBeTruthy();
  });
});

/**
 * Helper: an already-subscribed address holding a LIVE code that has never
 * been confirmed as sent (welcome_sent_at null) — the resend branch.
 */
function seedResendable(id: string, email: string) {
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString();
  db.tables.promo_codes.push({
    id: `${id}_promo`,
    code: `WELCOME-${id.toUpperCase()}`,
    active: true,
    current_uses: 0,
    max_uses: 1,
    expires_at: future,
  });
  db.tables.newsletter_subscribers.push({
    id,
    email,
    unsubscribed_at: null,
    promo_code_id: `${id}_promo`,
    source: null,
    welcome_sent_at: null,
  });
}

describe("POST /api/newsletter — the resend path is metered", () => {
  it("a welcome_sent_at stamp that keeps failing cannot hand out unlimited resends: the mint quota stops it", async () => {
    seedResendable("sub_stampfail", "stampfail@example.com");
    // A SUSTAINED fault, not a one-shot: the cooldown can never arm, so every
    // resubmission of this address takes the resend branch. Before pass 5
    // that branch never charged the mint quota, leaving the 60/min request
    // tier as the only brake — 60 welcome emails a minute to a known address.
    db.failAlways(
      "newsletter_subscribers",
      "update",
      "connection reset",
      "08006"
    );

    for (let i = 0; i < 15; i++) {
      const res = await POST(post({ email: "stampfail@example.com" }));
      expect(res.status).toBe(200);
    }
    const limited = await POST(post({ email: "stampfail@example.com" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");

    // 15 sends, bounded by the mint quota — not 16, and nothing like the 60
    // the request tier alone would have allowed.
    expect(resendSend).toHaveBeenCalledTimes(15);
    expect(db.tables.newsletter_subscribers[0].welcome_sent_at).toBeFalsy();

    // The stamp failure is a real fault and IS reported — but deduped to one
    // event per warm instance, not one per delivered email.
    expect(sentry.captureException).toHaveBeenCalledTimes(1);

    db.clearFailAlways("newsletter_subscribers", "update");
  });

  it("with the mint quota spent, a resend-eligible address 429s instead of sending", async () => {
    seedResendable("sub_after_quota", "afterquota@example.com");
    for (let i = 0; i < 15; i++) {
      expect((await POST(post({ email: `fresh${i}@example.com` }))).status).toBe(200);
    }
    expect(resendSend).toHaveBeenCalledTimes(15);

    const res = await POST(post({ email: "afterquota@example.com" }));
    expect(res.status).toBe(429);
    // No 16th email: the resend is charged like any other send.
    expect(resendSend).toHaveBeenCalledTimes(15);
  });
});

describe("POST /api/newsletter — status parity under mint-quota pressure", () => {
  it("once the mint quota is spent, an already-subscribed address gets the same 429 as an unknown one", async () => {
    // Read-only branches do not CHARGE the mint quota (a shared IP's signup
    // budget shouldn't be spendable by lookups), but they must not return 200
    // while a new address from the same IP gets a 429 — the status would then
    // answer exactly what the unified body withholds.
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString();
    db.tables.promo_codes.push({
      id: "promo_parity",
      code: "WELCOME-PARITY",
      active: true,
      current_uses: 0,
      max_uses: 1,
      expires_at: future,
    });
    db.tables.newsletter_subscribers.push({
      id: "sub_parity",
      email: "parity@example.com",
      unsubscribed_at: null,
      promo_code_id: "promo_parity",
      source: null,
      welcome_sent_at: new Date().toISOString(),
    });

    // Before the quota is spent both answer 200 — also part of the parity.
    expect((await POST(post({ email: "parity@example.com" }))).status).toBe(200);

    for (let i = 0; i < 15; i++) {
      await POST(post({ email: `burn${i}@example.com` }));
    }

    const known = await POST(post({ email: "parity@example.com" }));
    const unknown = await POST(post({ email: "never-seen@example.com" }));
    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);
    expect(await known.json()).toEqual(await unknown.json());
    expect(known.headers.get("Retry-After")).toBe(unknown.headers.get("Retry-After"));

    // Peeking must not have consumed budget of its own: exactly the 15 new
    // signups minted, and the known-address requests minted nothing.
    expect(db.tables.promo_codes).toHaveLength(16);
  });
});

describe("POST /api/newsletter — subscriber lookup errors", () => {
  it("a non-PGRST116 error on the subscriber lookup returns 503, not a route to new-signup", async () => {
    db.failOnce("newsletter_subscribers", "select", "connection reset", "08006");

    const res = await POST(post({ email: "lookupfail@example.com" }));
    expect(res.status).toBe(503);
    expect(sentry.captureException).toHaveBeenCalled();
    expect(db.tables.promo_codes).toHaveLength(0);
  });
});

describe("POST /api/newsletter — promo lookup errors", () => {
  it("a non-PGRST116 error on the promo lookup returns 503 and does not mint a duplicate code", async () => {
    db.tables.newsletter_subscribers.push({
      id: "sub_promo_err",
      email: "promoerr@example.com",
      unsubscribed_at: null,
      promo_code_id: "promo_missing_row",
      source: null,
    });
    db.failOnce("promo_codes", "select", "connection reset", "08006");

    const res = await POST(post({ email: "promoerr@example.com" }));
    expect(res.status).toBe(503);
    expect(sentry.captureException).toHaveBeenCalled();
    expect(db.tables.promo_codes).toHaveLength(0);
  });
});

describe("POST /api/newsletter — deploy-window schema-cache errors", () => {
  it("42703 on the subscriber SELECT retries without welcome_sent_at, and treats the unreadable cooldown as ACTIVE", async () => {
    seedResendable("sub_window", "window@example.com");
    // Migration 024 not applied: naming welcome_sent_at fails the WHOLE
    // SELECT. The retry drops the column — but the cooldown then cannot be
    // read OR written, so "unknown" must mean "active", not "never sent".
    // Otherwise every already-subscribed address is resendable on every
    // request for the length of the deploy window.
    db.failOnce(
      "newsletter_subscribers",
      "select",
      "column newsletter_subscribers.welcome_sent_at does not exist",
      "42703"
    );

    const res = await POST(post({ email: "window@example.com", source: "blog" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: SUCCESS_MESSAGE });

    // No resend, no re-mint, and the retry itself is not a fault.
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.tables.promo_codes).toHaveLength(1);
    expect(sentry.captureException).not.toHaveBeenCalled();
    // Attribution still lands — it is a separate, column-tolerant UPDATE.
    expect(db.tables.newsletter_subscribers[0].source).toBe("blog");
  });

  it("PGRST204 on the attribution UPDATE (024 not yet applied) is swallowed, not reported, and the signup still succeeds", async () => {
    db.failOnce("newsletter_subscribers", "update", "column not found in schema cache", "PGRST204");

    const res = await POST(post({ email: "deploywindow@example.com", source: "blog" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(db.tables.newsletter_subscribers).toHaveLength(1);
  });
});
