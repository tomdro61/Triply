/**
 * PUT /api/user/profile — a signed-in customer saves their name and phone.
 * An existing row is updated; a NEW row is linked to the account under its
 * auth email, so it is created only for a confirmed email.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db, h } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    h: {
      user: null as { id: string; email: string | undefined; email_confirmed_at: string | null } | null,
      captureAPIError: vi.fn(),
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.user }, error: null }),
      updateUser: async () => ({ data: {}, error: null }),
    },
  }),
  createAdminClient: async () => db,
}));
vi.mock("@/lib/sentry", () => ({ captureAPIError: h.captureAPIError }));

const { PUT } = await import("../route");

const put = () =>
  PUT(
    new NextRequest("http://localhost/api/user/profile", {
      method: "PUT",
      body: JSON.stringify({ firstName: "Ada", lastName: "Lovelace", phone: "555-0100" }),
    })
  );

beforeEach(() => {
  db.tables = { customers: [] };
  h.captureAPIError.mockClear();
});

describe("PUT /api/user/profile", () => {
  it("a confirmed account with no row gets a new row linked to it under its auth email", async () => {
    h.user = { id: "ada-uid", email: "ada@example.com", email_confirmed_at: "2026-11-01T00:00:00Z" };

    const res = await put();

    expect(res.status).toBe(200);
    expect(db.tables.customers).toHaveLength(1);
    expect(db.tables.customers[0]).toMatchObject({ user_id: "ada-uid", email: "ada@example.com", first_name: "Ada" });
  });

  it("an unconfirmed email creates no row", async () => {
    h.user = { id: "ada-uid", email: "ada@example.com", email_confirmed_at: null };

    const res = await put();

    expect(res.status).toBe(403);
    expect(db.tables.customers).toHaveLength(0);
  });

  it("an existing row is still updated (no new row needed)", async () => {
    h.user = { id: "ada-uid", email: "ada@example.com", email_confirmed_at: null };
    db.seed("customers", [{ id: "ada", email: "ada@example.com", user_id: "ada-uid", first_name: "Old", phone: "000" }]);

    const res = await put();

    expect(res.status).toBe(200);
    expect(db.tables.customers).toHaveLength(1);
    expect(db.tables.customers[0]).toMatchObject({ first_name: "Ada", phone: "555-0100" });
  });
});
