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

import { GET } from "../route";
import { signWaitlistId } from "@/lib/waitlist/unsubscribe-token";

beforeEach(() => {
  vi.clearAllMocks();
  db.tables = {
    booking_waitlist: [
      { id: "row_1", email: "a@example.com", unsubscribed_at: null },
    ],
  };
});

function get(params: Record<string, string>) {
  const url = new URL("https://www.triplypro.com/api/waitlist/unsubscribe");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/waitlist/unsubscribe", () => {
  it("a valid token sets unsubscribed_at and returns 200 HTML", async () => {
    const token = signWaitlistId("row_1");
    const res = await GET(get({ id: "row_1", token }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(db.tables.booking_waitlist[0].unsubscribed_at).not.toBeNull();
  });

  it("a forged/mismatched token → 400, nothing written", async () => {
    const res = await GET(get({ id: "row_1", token: "0".repeat(64) }));
    expect(res.status).toBe(400);
    expect(db.tables.booking_waitlist[0].unsubscribed_at).toBeNull();
  });

  it("a token valid for a DIFFERENT id → 400", async () => {
    const token = signWaitlistId("row_2");
    const res = await GET(get({ id: "row_1", token }));
    expect(res.status).toBe(400);
    expect(db.tables.booking_waitlist[0].unsubscribed_at).toBeNull();
  });

  it("missing id or token → 400", async () => {
    expect((await GET(get({ token: "abc" }))).status).toBe(400);
    expect((await GET(get({ id: "row_1" }))).status).toBe(400);
  });
});
