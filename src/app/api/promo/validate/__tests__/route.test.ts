/**
 * PR #23 pass 3, item 4: this route had its own inline copy of "is this
 * promo code usable", which drifted from the shared predicate once already
 * (see src/lib/promo/usable.ts's own doc comment). The three explicit checks
 * below still produce their specific messages, but isPromoCodeUsable is the
 * final authority — these tests exercise the predicate boundaries the route
 * must agree with checkout/newsletter on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { db, captureException } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase(), captureException: vi.fn() };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@sentry/nextjs", () => ({
  captureException,
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn() }),
}));

import { POST } from "../route";

function post(body: unknown) {
  return new NextRequest("https://www.triplypro.com/api/promo/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  db.tables = { promo_codes: [], promo_redemptions: [], pending_bookings: [] };
  db.log = [];
});

describe("POST /api/promo/validate", () => {
  it("an active, unexpired, under-limit code is valid", async () => {
    db.tables.promo_codes.push({
      id: "p1",
      code: "WELCOME-ABC",
      discount_percent: 10,
      active: true,
      expires_at: null,
      max_uses: null,
      current_uses: 0,
    });

    const res = await POST(post({ code: "welcome-abc" }));
    const json = await res.json();
    expect(json.valid).toBe(true);
    expect(json.discountPercent).toBe(10);
  });

  it("current_uses === max_uses (boundary) is invalid via the shared predicate, not just the route's own copy", async () => {
    db.tables.promo_codes.push({
      id: "p2",
      code: "USEDUP",
      discount_percent: 10,
      active: true,
      expires_at: null,
      max_uses: 1,
      current_uses: 1,
    });

    const res = await POST(post({ code: "USEDUP" }));
    const json = await res.json();
    expect(json.valid).toBe(false);
    expect(json.error).toMatch(/usage limit/i);
  });

  it("null max_uses means unlimited (matches checkout/newsletter's reading, not a naive 0 < null)", async () => {
    db.tables.promo_codes.push({
      id: "p3",
      code: "EVERGREEN",
      discount_percent: 15,
      active: true,
      expires_at: null,
      max_uses: null,
      current_uses: 500,
    });

    const res = await POST(post({ code: "EVERGREEN" }));
    const json = await res.json();
    expect(json.valid).toBe(true);
  });

  it("inactive code is invalid with the specific message", async () => {
    db.tables.promo_codes.push({
      id: "p4",
      code: "OFF",
      discount_percent: 10,
      active: false,
      expires_at: null,
      max_uses: null,
      current_uses: 0,
    });

    const res = await POST(post({ code: "OFF" }));
    const json = await res.json();
    expect(json.valid).toBe(false);
    expect(json.error).toMatch(/no longer active/i);
  });

  it("expired code is invalid with the specific message", async () => {
    db.tables.promo_codes.push({
      id: "p5",
      code: "STALE",
      discount_percent: 10,
      active: true,
      expires_at: new Date(Date.now() - 1000).toISOString(),
      max_uses: null,
      current_uses: 0,
    });

    const res = await POST(post({ code: "STALE" }));
    const json = await res.json();
    expect(json.valid).toBe(false);
    expect(json.error).toMatch(/expired/i);
  });

  it("unknown code is invalid", async () => {
    const res = await POST(post({ code: "NOPE" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.valid).toBe(false);
    expect(json.error).toMatch(/invalid promo code/i);
    // A genuine miss is not a fault — nothing to report.
    expect(captureException).not.toHaveBeenCalled();
  });

  it("a DB fault on the lookup is a 503 that says so, not a 200 'Invalid promo code'", async () => {
    // Pass-4 review: a connection reset used to be collapsed into the same
    // 200 "Invalid promo code" as a genuinely unknown code, with nothing to
    // Sentry — so a Supabase blip silently told every customer at checkout
    // that their valid code was bad. Only PGRST116 (no row) means "unknown".
    db.tables.promo_codes.push({
      id: "p6",
      code: "REALCODE",
      discount_percent: 10,
      active: true,
      expires_at: null,
      max_uses: null,
      current_uses: 0,
    });
    db.failOnce("promo_codes", "select", "connection reset", "08006");

    const res = await POST(post({ code: "REALCODE" }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.valid).toBe(false);
    expect(json.error).toMatch(/couldn't check that code right now/i);
    // Distinguishable from the "Invalid promo code" a real miss returns, so
    // the checkout form shows retry copy rather than rejecting the code.
    expect(json.error).not.toMatch(/invalid promo code/i);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  describe("once-per-customer (migration 033)", () => {
    const once = {
      id: "p7",
      code: "WELCOME-ONE",
      discount_percent: 10,
      active: true,
      expires_at: null,
      max_uses: null,
      current_uses: 3,
      once_per_customer: true,
    };
    const usedBy = (email_lower: string, status = "completed", livemode = false) => {
      db.tables.promo_redemptions.push({
        id: "r1",
        promo_code_id: "p7",
        code: "WELCOME-ONE",
        email_lower,
        stripe_payment_intent_id: "pi_first",
        livemode,
        released_at: null,
      });
      db.tables.pending_bookings.push({ stripe_payment_intent_id: "pi_first", status });
    };

    it("an email that already used the code gets the clear message", async () => {
      db.tables.promo_codes.push({ ...once });
      usedBy("ada@example.com");

      const json = await (await POST(post({ code: "WELCOME-ONE", email: "ada@example.com" }))).json();
      expect(json.valid).toBe(false);
      expect(json.reason).toBe("already_used");
      expect(json.error).toBe("This code has already been used with this email");
    });

    it("matches the email case-insensitively", async () => {
      db.tables.promo_codes.push({ ...once });
      usedBy("ada@example.com");

      const json = await (await POST(post({ code: "welcome-one", email: "  Ada@Example.COM " }))).json();
      expect(json.valid).toBe(false);
      expect(json.reason).toBe("already_used");
    });

    it("a different email may use it", async () => {
      db.tables.promo_codes.push({ ...once });
      usedBy("ada@example.com");

      const json = await (await POST(post({ code: "WELCOME-ONE", email: "grace@example.com" }))).json();
      expect(json.valid).toBe(true);
    });

    it("no email yet (promo box used before the details step) is valid — checked again at checkout", async () => {
      db.tables.promo_codes.push({ ...once });
      usedBy("ada@example.com");

      const json = await (await POST(post({ code: "WELCOME-ONE" }))).json();
      expect(json.valid).toBe(true);
    });

    it("a half-typed email is ignored, never turned into a 400 'invalid code'", async () => {
      db.tables.promo_codes.push({ ...once });

      const res = await POST(post({ code: "WELCOME-ONE", email: "ada@exa" }));
      expect(res.status).toBe(200);
      expect((await res.json()).valid).toBe(true);
    });

    it("a claim whose booking never went through does not count", async () => {
      db.tables.promo_codes.push({ ...once });
      usedBy("ada@example.com", "released_failed");

      const json = await (await POST(post({ code: "WELCOME-ONE", email: "ada@example.com" }))).json();
      expect(json.valid).toBe(true);
    });

    it("once_per_customer = false (every pre-033 code) is not limited", async () => {
      db.tables.promo_codes.push({ ...once, once_per_customer: false });
      usedBy("ada@example.com");

      const json = await (await POST(post({ code: "WELCOME-ONE", email: "ada@example.com" }))).json();
      expect(json.valid).toBe(true);
    });

    it("a DB fault on the redemption lookup is a 503, not a verdict", async () => {
      db.tables.promo_codes.push({ ...once });
      db.failOnce("promo_redemptions", "select", "connection reset", "08006");

      const res = await POST(post({ code: "WELCOME-ONE", email: "ada@example.com" }));
      expect(res.status).toBe(503);
      expect((await res.json()).valid).toBe(false);
      expect(captureException).toHaveBeenCalledTimes(1);
    });
  });
});
