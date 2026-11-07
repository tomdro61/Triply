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
  db.tables = { promo_codes: [] };
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
});

describe("POST /api/promo/validate — the code's RULE (promo plan Part 2)", () => {
  const usable = { active: true, expires_at: null, max_uses: 100, current_uses: 0 };

  it("a percent code: kind percent, its percent, no amount, its minimum (0 when none)", async () => {
    db.tables.promo_codes.push({ id: "p7", code: "THANKS10", discount_percent: 10, discount_amount: null, min_subtotal: null, ...usable });
    expect(await (await POST(post({ code: " thanks10 " }))).json()).toEqual({
      valid: true,
      code: "THANKS10",
      kind: "percent",
      discountPercent: 10,
      discountCents: null,
      minSubtotalCents: 0,
    });
  });

  it("a fixed code with PROMO_FIXED_ENABLED on: kind fixed, the amount and minimum in cents, discountPercent null (stale tabs)", async () => {
    vi.stubEnv("PROMO_FIXED_ENABLED", "true");
    db.tables.promo_codes.push({ id: "p8", code: "JFK5", discount_percent: null, discount_amount: "5.00", min_subtotal: "25.00", ...usable });
    expect(await (await POST(post({ code: "jfk5" }))).json()).toEqual({
      valid: true,
      code: "JFK5",
      kind: "fixed",
      discountPercent: null,
      discountCents: 500,
      minSubtotalCents: 2500,
    });
    vi.unstubAllEnvs();
  });

  it("the kill switch: a fixed code with PROMO_FIXED_ENABLED unset is not available — percent codes unaffected", async () => {
    db.tables.promo_codes.push(
      { id: "p9", code: "JFK5", discount_percent: null, discount_amount: "5.00", min_subtotal: "25.00", ...usable },
      { id: "p10", code: "THANKS10", discount_percent: 10, discount_amount: null, min_subtotal: null, ...usable }
    );
    expect(await (await POST(post({ code: "JFK5" }))).json()).toEqual({
      valid: false,
      error: "This promo code isn't available right now",
      reason: "not_available",
    });
    expect((await (await POST(post({ code: "THANKS10" }))).json()).valid).toBe(true);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("a malformed row (both kinds) is not available, and reported", async () => {
    vi.stubEnv("PROMO_FIXED_ENABLED", "true");
    db.tables.promo_codes.push({ id: "p11", code: "BOTH", discount_percent: 10, discount_amount: "5.00", min_subtotal: null, ...usable });
    expect(await (await POST(post({ code: "BOTH" }))).json()).toMatchObject({ valid: false, reason: "not_available" });
    expect(captureException).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});
