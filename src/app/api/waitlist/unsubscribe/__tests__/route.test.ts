import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, sentry } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    sentry: { captureMessage: vi.fn(), withScope: vi.fn(), captureException: vi.fn() },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: sentry.captureMessage,
  captureException: sentry.captureException,
  withScope: (fn: (scope: unknown) => void) => {
    sentry.withScope();
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn() });
  },
}));

import { GET, POST } from "../route";
import { signWaitlistId } from "@/lib/waitlist/unsubscribe-token";

beforeEach(() => {
  vi.clearAllMocks();
  db.tables = {
    booking_waitlist: [
      { id: "row_1", email: "a@example.com", unsubscribed_at: null },
      // Same address as row_1, a different trip — the address-level
      // suppression case.
      { id: "row_2", email: "a@example.com", unsubscribed_at: null },
      { id: "row_3", email: "b@example.com", unsubscribed_at: null },
    ],
  };
});

function req(params: Record<string, string>) {
  const url = new URL("https://www.triplypro.com/api/waitlist/unsubscribe");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/waitlist/unsubscribe — confirm page only", () => {
  it("a valid token → 200 HTML confirm page, does NOT unsubscribe", async () => {
    const token = signWaitlistId("row_1");
    const res = await GET(req({ id: "row_1", token }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/<form method="post"/);
    expect(db.tables.booking_waitlist[0].unsubscribed_at).toBeNull();
  });

  it("a forged/mismatched token → 400", async () => {
    const res = await GET(req({ id: "row_1", token: "0".repeat(64) }));
    expect(res.status).toBe(400);
  });

  it("a token valid for a DIFFERENT id → 400", async () => {
    const token = signWaitlistId("row_2_other");
    const res = await GET(req({ id: "row_1", token }));
    expect(res.status).toBe(400);
  });

  it("missing id or token → 400", async () => {
    expect((await GET(req({ token: "abc" }))).status).toBe(400);
    expect((await GET(req({ id: "row_1" }))).status).toBe(400);
  });

  it("unknown/deleted id → 404, not a false 200", async () => {
    const token = signWaitlistId("row_missing");
    const res = await GET(req({ id: "row_missing", token }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/waitlist/unsubscribe — performs the unsubscribe", () => {
  it("a valid token → 200, and suppresses every row for that ADDRESS, not just this id", async () => {
    const token = signWaitlistId("row_1");
    const res = await POST(req({ id: "row_1", token }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);

    const [row1, row2, row3] = db.tables.booking_waitlist;
    expect(row1.unsubscribed_at).not.toBeNull();
    // row_2 shares row_1's email and was never named in the link — still
    // suppressed, because List-Unsubscribe is an address-level signal.
    expect(row2.unsubscribed_at).not.toBeNull();
    // A different address is untouched.
    expect(row3.unsubscribed_at).toBeNull();
  });

  it("a forged/mismatched token → 400, nothing written", async () => {
    const res = await POST(req({ id: "row_1", token: "0".repeat(64) }));
    expect(res.status).toBe(400);
    expect(db.tables.booking_waitlist[0].unsubscribed_at).toBeNull();
  });

  it("suppresses a row whose stored email is a different case than the token's row (unique index is on lower(email))", async () => {
    db.tables.booking_waitlist = [
      { id: "row_mixed", email: "Mixed@Example.com", unsubscribed_at: null },
      { id: "row_mixed_2", email: "mixed@example.com", unsubscribed_at: null },
    ];
    const token = signWaitlistId("row_mixed");
    const res = await POST(req({ id: "row_mixed", token }));
    expect(res.status).toBe(200);
    const [row1, row2] = db.tables.booking_waitlist;
    expect(row1.unsubscribed_at).not.toBeNull();
    expect(row2.unsubscribed_at).not.toBeNull();
  });

  it("an update() error on the suppression write → 500, not a false 200", async () => {
    db.tables.booking_waitlist = [{ id: "row_only", email: "only@example.com", unsubscribed_at: null }];
    db.failOnce("booking_waitlist", "update", "connection reset", "08006");
    const token = signWaitlistId("row_only");
    const res = await POST(req({ id: "row_only", token }));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toMatch(/you're unsubscribed/i);
    expect(db.tables.booking_waitlist[0].unsubscribed_at).toBeNull();
  });

  it("a token valid for a DIFFERENT id → 400, nothing written", async () => {
    const token = signWaitlistId("row_2_other");
    const res = await POST(req({ id: "row_1", token }));
    expect(res.status).toBe(400);
    expect(db.tables.booking_waitlist[0].unsubscribed_at).toBeNull();
  });

  it("missing id or token → 400", async () => {
    expect((await POST(req({ token: "abc" }))).status).toBe(400);
    expect((await POST(req({ id: "row_1" }))).status).toBe(400);
  });

  it("unknown/deleted id (valid token for it) → 404, honest message, not a false 200", async () => {
    const token = signWaitlistId("row_missing");
    const res = await POST(req({ id: "row_missing", token }));
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toMatch(/you're unsubscribed/i);
  });

  it("this is the URL List-Unsubscribe-Post targets — works with id+token in the query string alone, no body", async () => {
    const token = signWaitlistId("row_3");
    const url = new URL("https://www.triplypro.com/api/waitlist/unsubscribe");
    url.searchParams.set("id", "row_3");
    url.searchParams.set("token", token);
    const res = await POST(new NextRequest(url, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(db.tables.booking_waitlist[2].unsubscribed_at).not.toBeNull();
  });
});
