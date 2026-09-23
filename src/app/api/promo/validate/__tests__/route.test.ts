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

const { db } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase() };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
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
    const json = await res.json();
    expect(json.valid).toBe(false);
  });
});
