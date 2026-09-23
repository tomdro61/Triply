import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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

  it("an address containing an underscore suppresses ONLY that address, never the lookalikes a LIKE pattern would match", async () => {
    // The pass-4 bug this pins: `.ilike("email", "first_last@gmail.com")`
    // reads `_` as "any one character", so unsubscribing this traveller also
    // opted out `first.last@`, `first-last@` and `firstXlast@` — strangers,
    // silently, because those rows DO match and the empty-result guard never
    // fires. The fake models ilike as a real LIKE pattern, so this test fails
    // against `.ilike` and only passes against `.eq`.
    db.tables.booking_waitlist = [
      { id: "underscore", email: "first_last@gmail.com", unsubscribed_at: null },
      { id: "dot", email: "first.last@gmail.com", unsubscribed_at: null },
      { id: "dash", email: "first-last@gmail.com", unsubscribed_at: null },
      { id: "letter", email: "firstxlast@gmail.com", unsubscribed_at: null },
    ];
    const token = signWaitlistId("underscore");
    const res = await POST(req({ id: "underscore", token }));
    expect(res.status).toBe(200);

    const byId = (id: string) => db.tables.booking_waitlist.find((r) => r.id === id);
    expect(byId("underscore")?.unsubscribed_at).not.toBeNull();
    expect(byId("dot")?.unsubscribed_at).toBeNull();
    expect(byId("dash")?.unsubscribed_at).toBeNull();
    expect(byId("letter")?.unsubscribed_at).toBeNull();
  });

  it("a stored address that is not lowercase fails LOUDLY rather than reporting a false success", async () => {
    // Every row is written lowercased (the zod transform in /api/waitlist)
    // and migration 026 adds a CHECK enforcing it, so this row can only exist
    // if someone inserted it by hand. The suppression UPDATE is `.eq` on the
    // lowercased address — matching it case-insensitively would mean `.ilike`
    // and its wildcard hazard (see the test above). What must NOT happen is
    // the traveller being told they are unsubscribed while their rows stay
    // live, so the zero-match guard turns it into a 500 plus a Sentry event.
    db.tables.booking_waitlist = [
      { id: "row_mixed", email: "Mixed@Example.com", unsubscribed_at: null },
    ];
    const token = signWaitlistId("row_mixed");
    const res = await POST(req({ id: "row_mixed", token }));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toMatch(/you're unsubscribed/i);
    expect(db.tables.booking_waitlist[0].unsubscribed_at).toBeNull();
    expect(sentry.captureException).toHaveBeenCalled();
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

describe("/api/waitlist/unsubscribe — a missing signing secret", () => {
  const ORIGINAL_SECRET = process.env.WAITLIST_SIGNING_SECRET;
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.WAITLIST_SIGNING_SECRET;
    } else {
      process.env.WAITLIST_SIGNING_SECRET = ORIGINAL_SECRET;
    }
  });

  it("GET → the branded 500 page and a Sentry capture, NOT a 400 'invalid link' and NOT Next's raw 500", async () => {
    const token = signWaitlistId("row_1");
    delete process.env.WAITLIST_SIGNING_SECRET;

    const res = await GET(req({ id: "row_1", token }));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/Triply/);
    // "This link is invalid" would tell a traveller holding a perfectly good
    // link to stop trying.
    expect(body).not.toMatch(/invalid or has expired/i);
    expect(sentry.captureException).toHaveBeenCalled();
  });

  it("POST (the one-click List-Unsubscribe-Post target) → the branded 500 page, nothing written", async () => {
    const token = signWaitlistId("row_1");
    delete process.env.WAITLIST_SIGNING_SECRET;

    const res = await POST(req({ id: "row_1", token }));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).not.toMatch(/invalid or has expired/i);
    expect(body).not.toMatch(/you're unsubscribed/i);
    expect(db.tables.booking_waitlist[0].unsubscribed_at).toBeNull();
    expect(sentry.captureException).toHaveBeenCalled();
  });
});
