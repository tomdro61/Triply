/**
 * The support inbox admin API: admin-only, and PATCH follows the ticket rules
 * (markReplied stamps first_response_at once and moves new → waiting; done
 * stamps resolved_at; reopening clears it; owners must be team members).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  user: { email: "vin@triplypro.com" } as null | { email: string },
  current: { status: "new", first_response_at: null as string | null } as null | { status: string; first_response_at: string | null },
  updates: [] as Array<Record<string, unknown>>,
  ors: [] as string[],
  orders: [] as Array<[string, boolean]>,
  countError: null as null | { message: string },
  // The ticket's updated_at as stored; a conditional PATCH must match it.
  updatedAt: "2026-11-05T10:00:00.000Z",
  eqs: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));
vi.mock("@/config/admin", () => ({
  isAdminEmail: (e?: string | null) => !!e && ["vin@triplypro.com", "john@triplypro.com", "tom@triplypro.com"].includes(e.toLowerCase()),
  ALERT_EMAILS: ["vin@triplypro.com", "john@triplypro.com", "outsider@example.com"],
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } })),
  // One thenable query builder: records filters/orders, resolves by what the query is.
  createAdminClient: vi.fn(async () => ({
    from() {
      let head = false;
      let updating = false;
      let expected: unknown = undefined;
      const b = {
        select: (_c: string, opts?: { head?: boolean }) => ((head = !!opts?.head), b),
        in: () => b,
        eq: (col: string, v: unknown) => (state.eqs.push([col, v]), col === "updated_at" && (expected = v), b),
        or: (f: string) => (state.ors.push(f), b),
        order: (col: string, o: { ascending: boolean }) => (state.orders.push([col, o.ascending]), b),
        range: () => b,
        update: (patch: Record<string, unknown>) => (state.updates.push(patch), (updating = true), b),
        maybeSingle: async () => ({ data: state.current, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve(
            head
              ? { count: 1, error: state.countError }
              : updating
                ? { data: expected === state.updatedAt ? [{ id: "t" }] : [], error: null }
                : { data: [], error: null, count: 0 }
          ),
      };
      return b;
    },
  })),
}));

import { GET } from "../route";
import { PATCH } from "../[id]/route";

const ID = "11111111-1111-4111-8111-111111111111";
// Every save names the version it was based on (expectedUpdatedAt).
const patchReq = (body: Record<string, unknown>) =>
  new NextRequest(`https://www.triplypro.com/api/admin/support/${ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedUpdatedAt: "2026-11-05T10:00:00.000Z", ...body }),
  });
const params = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  state.user = { email: "vin@triplypro.com" };
  state.current = { status: "new", first_response_at: null };
  state.updates = [];
  state.ors = [];
  state.orders = [];
  state.countError = null;
  state.updatedAt = "2026-11-05T10:00:00.000Z";
  state.eqs = [];
});

describe("GET /api/admin/support", () => {
  it("401 signed out, 403 for a non-admin", async () => {
    state.user = null;
    expect((await GET(new NextRequest("https://x/api/admin/support"))).status).toBe(401);
    state.user = { email: "someone@example.com" };
    expect((await GET(new NextRequest("https://x/api/admin/support"))).status).toBe(403);
  });

  it("open view sorts urgent first then oldest; assignees are alert ∩ admins", async () => {
    const res = await GET(new NextRequest("https://x/api/admin/support?view=open"));
    expect(res.status).toBe(200);
    expect(state.orders).toEqual([["priority_rank", true], ["created_at", true]]);
    expect((await res.json()).assignees).toEqual(["vin@triplypro.com", "john@triplypro.com"]);
  });

  it("strips filter syntax from search; ticket_number only for digits", async () => {
    await GET(new NextRequest("https://x/api/admin/support?search=pat,(x)%25"));
    expect(state.ors[0]).not.toMatch(/[(),%]x|ticket_number/);
    await GET(new NextRequest("https://x/api/admin/support?search=1042"));
    expect(state.ors[1]).toContain("ticket_number.eq.1042");
  });

  it("a failed count is a 500, never '0 urgent'", async () => {
    state.countError = { message: "boom" };
    expect((await GET(new NextRequest("https://x/api/admin/support"))).status).toBe(500);
  });

  it("lists and counts only this deployment's tickets (staging and production share the database)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await GET(new NextRequest("https://x/api/admin/support"));
    expect(state.eqs.filter(([c]) => c === "livemode").every(([, v]) => v === false)).toBe(true);
    expect(state.eqs.filter(([c]) => c === "livemode")).toHaveLength(3); // list + 2 counts
    vi.unstubAllEnvs();
  });

  it("rejects an unknown view", async () => {
    expect((await GET(new NextRequest("https://x/api/admin/support?view=nope"))).status).toBe(400);
  });
});

describe("PATCH /api/admin/support/[id]", () => {
  it("markReplied stamps first_response_at and moves new → waiting", async () => {
    expect((await PATCH(patchReq({ markReplied: true }), params)).status).toBe(200);
    expect(state.updates[0]).toMatchObject({ status: "waiting" });
    expect(state.updates[0].first_response_at).toEqual(expect.any(String));
  });

  it("markReplied never overwrites an earlier first response", async () => {
    state.current = { status: "open", first_response_at: "2026-11-01T00:00:00Z" };
    await PATCH(patchReq({ markReplied: true }), params);
    expect(state.updates[0]).not.toHaveProperty("first_response_at");
    expect(state.updates[0]).not.toHaveProperty("status");
  });

  it("done stamps resolved_at; reopening clears it", async () => {
    await PATCH(patchReq({ status: "done" }), params);
    expect(state.updates[0].resolved_at).toEqual(expect.any(String));
    state.current = { status: "done", first_response_at: null };
    await PATCH(patchReq({ status: "open" }), params);
    expect(state.updates[1].resolved_at).toBeNull();
  });

  it("refuses an owner who isn't on the team, unknown fields, and an empty body", async () => {
    expect((await PATCH(patchReq({ assignedTo: "outsider@example.com" }), params)).status).toBe(400);
    expect((await PATCH(patchReq({ priority: "normal" }), params)).status).toBe(400);
    expect((await PATCH(patchReq({}), params)).status).toBe(400);
    expect(state.updates).toEqual([]);
  });

  // Review round 1 (#156): one admin's notes never silently erase another's.
  it("a save based on an older version is a 409 and changes nothing", async () => {
    state.updatedAt = "2026-11-05T10:05:00.000Z"; // John saved after Vin opened it
    const res = await PATCH(patchReq({ notes: "called lot" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Someone else changed this ticket");
  });

  it("a save without the version it was based on is refused", async () => {
    const res = await PATCH(
      new NextRequest(`https://www.triplypro.com/api/admin/support/${ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: "x" }),
      }),
      params
    );
    expect(res.status).toBe(400);
    expect(state.updates).toEqual([]);
  });

  it("404 for a missing ticket; 403 for a non-admin", async () => {
    state.current = null;
    expect((await PATCH(patchReq({ status: "open" }), params)).status).toBe(404);
    state.user = { email: "someone@example.com" };
    expect((await PATCH(patchReq({ status: "open" }), params)).status).toBe(403);
  });
});
