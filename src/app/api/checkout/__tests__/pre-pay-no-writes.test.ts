/**
 * CONTRACT: nothing a customer does BEFORE clicking Pay writes to the
 * database, sends an email, or calls a service this test does not hand it.
 *
 * Why it is a contract: the checkout smoke test (e2e/, the `checkout-smoke`
 * CI job) drives these three handlers on every PR's preview, and a preview
 * uses the PRODUCTION database. The browser test can only see the requests
 * the page makes; this is the half that sees what the server does with them.
 *
 * If this test fails because you added a write to one of these handlers:
 * do not relax it. Either move the write to the Pay step, or take the
 * handler off the smoke test's allowlist (e2e/lib/guard.ts) in the same PR.
 *
 * What it watches: every Supabase client the app can build (the SDK
 * factories are replaced, so the app's own wrappers are real), Resend, and
 * `fetch`. Limits: `getLotById` and the ResLab client are mocked, so a write
 * added INSIDE them is not seen here.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { writes, makeClient, createPI, stripeMock, getLotById, getCost, getLocation, emails, fetches } = vi.hoisted(() => {
  const writes: string[] = [];
  // No read-only RPC is needed before Pay, so every RPC counts as a write.
  const WRITE_CALLS = new Set(["insert", "update", "upsert", "delete", "rpc", "remove", "upload"]);

  /** A query chain: every call is recorded if it writes; awaiting it reads nothing. */
  const chain = (path: string): unknown =>
    new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (value: { data: null; error: null }) => void) => resolve({ data: null, error: null });
        }
        return chain(`${path}.${String(prop)}`);
      },
      apply(_target, _self, args: unknown[]) {
        const name = path.split(".").pop() ?? "";
        if (WRITE_CALLS.has(name)) writes.push(path);
        const shown = typeof args[0] === "string" ? args[0] : "";
        return chain(`${path}(${shown})`);
      },
    });

  /** A client is not awaitable (an async factory returns it), its queries are. */
  const makeClient = (kind: string) =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") return undefined;
          return chain(`${kind}.${String(prop)}`);
        },
      }
    );

  return {
    writes,
    makeClient,
    createPI: vi.fn(),
    stripeMock: { paymentIntents: { retrieve: vi.fn(), update: vi.fn() } },
    getLotById: vi.fn(),
    getCost: vi.fn(),
    getLocation: vi.fn(),
    emails: vi.fn(),
    fetches: vi.fn(),
  };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => makeClient("server"),
  createBrowserClient: () => makeClient("browser"),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeClient("js") }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: emails };
    batch = { send: emails };
  },
}));
vi.mock("@/lib/stripe/client", () => ({ createPaymentIntent: createPI, stripe: stripeMock }));
vi.mock("@/lib/reslab/get-lot", () => ({ getLotById }));
vi.mock("@/lib/reslab/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reslab/client")>()),
  // Only the two read calls exist: a reservation call would throw and fail the status check.
  reslab: { getCost, getLocation },
}));
vi.mock("@/lib/reslab/search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reslab/search")>()),
  getChannelLocationsNoSweep: async () => [{ id: 42, currency: { code: "USD" } }],
}));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn(), capturePaymentError: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), withScope: vi.fn() }));

import { GET as getLot, POST as createIntent } from "../lot/route";
import { POST as updateIntent } from "../lot/update-pi/route";
import { POST as recordAttribution } from "../../attribution/route";
import { TERMS_VERSION } from "@/lib/checkout/terms-acceptance";
import { PROMO_PRICING_HEADER, PROMO_PRICING_VERSION } from "@/lib/promo/discount";
import { __resetAttributionRateLimitForTests } from "@/lib/attribution/limiter";

const STAY = { checkin: "2026-10-10", checkout: "2026-10-15", checkinTime: "10:00 AM", checkoutTime: "10:00 AM" };

const jsonPost = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });

/** Nothing left the process except through the mocks this file handed out. */
function expectNoSideEffects() {
  expect(writes, "a database write before Pay").toEqual([]);
  expect(emails, "an email before Pay").not.toHaveBeenCalled();
  expect(fetches, "an outside call before Pay").not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  __resetAttributionRateLimitForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T16:00:00Z"));
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  vi.stubGlobal("fetch", fetches.mockRejectedValue(new Error("no network in this test")));

  getLotById.mockResolvedValue({
    id: "reslab-42",
    source: "reslab",
    sourceId: "42",
    reslabLocationId: 42,
    name: "TEST Lot",
    availability: "available",
    pricing: { numberOfDays: 5, parkingTypes: [{ id: 7 }] },
  });
  getLocation.mockImplementation(async (id: number) => ({ id, currency: { code: "USD" } }));
  getCost.mockResolvedValue({
    costs_token: "tok",
    reservation: { sold_out: false, sub_total: 50, fees_total: 0, tax_total: 5, grand_total: 55, due_at_location: 0 },
  });
  createPI.mockResolvedValue({ id: "pi_smoke", client_secret: "cs_smoke" });
  stripeMock.paymentIntents.retrieve.mockResolvedValue({
    id: "pi_smoke",
    status: "requires_payment_method",
    amount: 6095,
    metadata: { parkingOnlyChargeAmountCents: "6095" },
  });
  stripeMock.paymentIntents.update.mockImplementation(async (id: string, params: { amount: number }) => ({
    id,
    amount: params.amount,
  }));
});

describe("the recorder itself", () => {
  it("sees a write and ignores a read (or the tests below prove nothing)", async () => {
    const { createAdminClient } = await import("@/lib/supabase/server");
    const client = await createAdminClient();
    await client.from("promo_codes").select("*").eq("code", "X").maybeSingle();
    expect(writes).toEqual([]);
    await client.from("pending_bookings").insert({});
    await client.rpc("anything");
    expect(writes).toHaveLength(2);
  });
});

describe("before Pay: no database write, no email, no outside call", () => {
  it("GET /api/checkout/lot (loading checkout)", async () => {
    const query = new URLSearchParams({ lotId: "reslab-42", ...STAY });
    const res = await getLot(new NextRequest(`http://localhost/api/checkout/lot?${query}`));
    expect(res.status).toBe(200);
    expect((await res.json()).costData.costsToken).toBe("tok");
    expectNoSideEffects();
  });

  it("POST /api/checkout/lot (Continue to Payment), with and without a promo code", async () => {
    const body = {
      lotId: "reslab-42",
      locationId: 42,
      ...STAY,
      parkingTypeId: 7,
      customerEmail: "ada@example.com",
      protectionPlanCode: null,
      termsVersion: TERMS_VERSION,
    };
    const headers = { [PROMO_PRICING_HEADER]: String(PROMO_PRICING_VERSION) };
    const plain = await createIntent(jsonPost("http://localhost/api/checkout/lot", body, headers));
    expect(plain.status).toBe(200);
    expect((await plain.json()).chargeCents).toBe(6095);
    // A code the database does not know: looked up (a read), refused, still a PaymentIntent.
    const withCode = await createIntent(jsonPost("http://localhost/api/checkout/lot", { ...body, promoCode: "NOPE" }, headers));
    expect(withCode.status).toBe(200);
    expect(createPI).toHaveBeenCalledTimes(2);
    expectNoSideEffects();
  });

  it("POST /api/checkout/lot/update-pi (picking and declining a protection plan)", async () => {
    for (const protectionPlanCode of ["C", null]) {
      const res = await updateIntent(
        jsonPost("http://localhost/api/checkout/lot/update-pi", { paymentIntentId: "pi_smoke", protectionPlanCode })
      );
      expect(res.status).toBe(200);
    }
    expect(stripeMock.paymentIntents.update).toHaveBeenCalledTimes(2);
    expectNoSideEffects();
  });

  it("POST /api/attribution (the page's first-touch cookie)", async () => {
    const host = "www.triplypro.com";
    const res = await recordAttribution(
      jsonPost(
        `https://${host}/api/attribution`,
        { touch: { src: "google", med: "cpc", click: "gclid:abc", land: "/checkout", at: 1 } },
        { host, "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.7" }
      )
    );
    expect(res.status).toBe(204);
    expectNoSideEffects();
  });
});
