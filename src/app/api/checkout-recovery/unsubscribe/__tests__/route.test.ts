import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase() };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() }),
  flush: vi.fn().mockResolvedValue(true),
}));

import { GET, POST } from "../route";
import { signRecoveryId } from "@/lib/checkout-recovery/unsubscribe-token";
import { signWaitlistId } from "@/lib/waitlist/unsubscribe-token";

function url(id: string, token: string) {
  return `https://www.triplypro.com/api/checkout-recovery/unsubscribe?id=${id}&token=${token}`;
}

beforeEach(() => {
  db.tables = {
    checkout_recovery_emails: [{ id: "send_1", email: "alice@example.com", stripe_payment_intent_id: "pi_1" }],
    checkout_recovery_optouts: [],
  };
  db.clearFailures();
});

describe("/api/checkout-recovery/unsubscribe", () => {
  it("GET only renders a confirm page — a link scanner must not opt anyone out", async () => {
    const res = await GET(new NextRequest(url("pi_1", signRecoveryId("pi_1"))));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('method="post"');
    expect(db.tables.checkout_recovery_optouts).toHaveLength(0);
  });

  it("POST with a valid token records an address-level opt-out, idempotently", async () => {
    const token = signRecoveryId("pi_1");
    expect((await POST(new NextRequest(url("pi_1", token), { method: "POST" }))).status).toBe(200);
    expect((await POST(new NextRequest(url("pi_1", token), { method: "POST" }))).status).toBe(200);
    expect(db.tables.checkout_recovery_optouts.map((r) => r.email)).toEqual(["alice@example.com"]);
  });

  it("the link is keyed on the PaymentIntent, not the ledger row id — a row id with a valid token is unknown", async () => {
    const res = await POST(new NextRequest(url("send_1", signRecoveryId("send_1")), { method: "POST" }));
    expect(res.status).toBe(404);
    expect(db.tables.checkout_recovery_optouts).toHaveLength(0);
  });

  it("rejects a bad token, and a WAITLIST token for the same id (domain-separated)", async () => {
    for (const token of ["deadbeef", signWaitlistId("pi_1")]) {
      const res = await POST(new NextRequest(url("pi_1", token), { method: "POST" }));
      expect(res.status).toBe(400);
    }
    expect(db.tables.checkout_recovery_optouts).toHaveLength(0);
  });

  it("an unknown id is an honest 404, not a false success", async () => {
    const res = await POST(new NextRequest(url("nope", signRecoveryId("nope")), { method: "POST" }));
    expect(res.status).toBe(404);
  });
});
