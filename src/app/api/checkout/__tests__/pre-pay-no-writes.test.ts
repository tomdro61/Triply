/**
 * CONTRACT: what a customer does BEFORE clicking Pay writes nothing to the
 * database, sends no email, and calls no service this test does not hand it.
 *
 * Why it is a contract: the checkout smoke test (e2e/, the `checkout-smoke`
 * CI job) calls GET and POST /api/checkout/lot, POST
 * /api/checkout/lot/update-pi and POST /api/attribution on every PR's
 * preview, and a preview uses the PRODUCTION database. The browser test can
 * only see the requests the page makes; this is the half that sees what the
 * server does with them. The CI job runs only after this test has passed.
 *
 * If this test fails because you added a write to one of these handlers: do
 * not relax it. Move the write to the Pay step, or stop the smoke test
 * calling the route in the same PR (a POST: remove it from ALLOWED_MUTATING
 * in e2e/lib/guard.ts; GET /api/checkout/lot: the walk cannot run without it).
 *
 * What it watches, fail-closed:
 * - Supabase: the SDK factories are replaced, so the app's own wrappers are
 *   real. Every call on a client counts as a write unless it is a known read.
 * - ResLab: any client method other than the three read calls.
 * - Resend, and global `fetch`.
 *
 * Limits (say so in a PR that leans on this test):
 * - Stripe's client module is mocked, and a call made with node:http instead
 *   of `fetch` is not seen.
 * - Only the paths the smoke test drives are run: a ResLab lot, with and
 *   without a promo code or a protection plan, and the price-estimate
 *   fallback. Direct lots are not: the smoke test never opens one.
 * - The ResLab location snapshot is off here (as when its switch is off).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { writes, reads, makeClient, createPI, stripeMock, reslabMock, reslabOther, emails, fetches } = vi.hoisted(() => {
  const writes: string[] = [];
  /** What a read returns, by table or RPC name. Anything else reads as "no row". */
  const reads: Record<string, unknown> = {};

  // An allowlist, like e2e/lib/guard.ts: a method this list does not know is a write.
  const READ_CALLS = new Set([
    "from", "schema", "select", "eq", "neq", "in", "is", "gt", "gte", "lt", "lte", "like", "ilike",
    "match", "filter", "not", "or", "order", "limit", "range", "single", "maybeSingle", "abortSignal",
  ]);
  /** Database functions that only read (src/lib/direct/store.ts). */
  const READ_RPCS = new Set(["direct_lots_v2"]);

  /** A query chain: awaiting it reads `reads[target]`; any call that is not a read is recorded. */
  const chain = (path: string, target: string): unknown =>
    new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (value: { data: unknown; error: null }) => void) =>
            resolve({ data: reads[target] ?? null, error: null });
        }
        return chain(`${path}.${String(prop)}`, target);
      },
      apply(_target, _self, args: unknown[]) {
        const name = path.split(".").pop() ?? "";
        const first = typeof args[0] === "string" ? args[0] : "";
        const called = `${path}(${first})`;
        const isRead = name === "rpc" ? READ_RPCS.has(first) : READ_CALLS.has(name);
        if (!isRead) writes.push(called);
        return chain(called, name === "from" || name === "rpc" ? first : target);
      },
    });

  /** A client is not awaitable (an async factory returns it); its queries are. */
  const makeClient = (kind: string) =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") return undefined;
          return chain(`${kind}.${String(prop)}`, "");
        },
      }
    );

  const reslabMock = { getCost: vi.fn(), getLocation: vi.fn(), getMinPrice: vi.fn() };
  const reslabOther: string[] = [];

  return {
    writes,
    reads,
    makeClient,
    createPI: vi.fn(),
    stripeMock: { paymentIntents: { retrieve: vi.fn(), update: vi.fn() } },
    reslabMock,
    reslabOther,
    emails: vi.fn(),
    fetches: vi.fn(),
  };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, key: string) => makeClient(key === "service" ? "admin" : "session"),
  createBrowserClient: () => makeClient("browser"),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeClient("js") }));
// The session client reads cookies first; outside a request that would throw
// before the client exists, and a write inside a try/catch would go unseen.
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: emails };
    batch = { send: emails };
  },
}));
vi.mock("@/lib/stripe/client", () => ({ createPaymentIntent: createPI, stripe: stripeMock }));
vi.mock("@/lib/reslab/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reslab/client")>()),
  // Three read calls exist. Anything else (a reservation, a cancellation) is
  // recorded, so it is caught even inside a try/catch.
  reslab: new Proxy(reslabMock, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop);
      return async () => {
        reslabOther.push(String(prop));
        throw new Error(`reslab.${String(prop)} is not a pre-Pay call`);
      };
    },
  }),
}));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn(), capturePaymentError: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn(), withScope: vi.fn() }));

import { GET as getLot, POST as createIntent } from "../lot/route";
import { POST as updateIntent } from "../lot/update-pi/route";
import { POST as recordAttribution } from "../../attribution/route";
import { TERMS_VERSION } from "@/lib/checkout/terms-acceptance";
import { PROMO_PRICING_HEADER, PROMO_PRICING_VERSION } from "@/lib/promo/discount";
import { __resetAttributionRateLimitForTests } from "@/lib/attribution/limiter";

const STAY = { checkin: "2026-10-10", checkout: "2026-10-15", checkinTime: "10:00 AM", checkoutTime: "10:00 AM" };
const COST = {
  costs_token: "tok",
  reservation: { sold_out: false, sub_total: 50, fees_total: 0, tax_total: 5, grand_total: 55, due_at_location: 0 },
};
const PROMO_ROW = { code: "TEN", discount_percent: 10, discount_amount: null, min_subtotal: null, active: true, expires_at: null, max_uses: null, current_uses: 0 };

const jsonPost = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });

const lotQuery = () => new NextRequest(`http://localhost/api/checkout/lot?${new URLSearchParams({ lotId: "reslab-42", ...STAY })}`);

const intentBody = (over: Record<string, unknown> = {}) => ({
  lotId: "reslab-42",
  locationId: 42,
  ...STAY,
  parkingTypeId: 7,
  customerEmail: "ada@example.com",
  protectionPlanCode: null,
  termsVersion: TERMS_VERSION,
  ...over,
});
const postIntent = (over: Record<string, unknown> = {}) =>
  createIntent(jsonPost("http://localhost/api/checkout/lot", intentBody(over), { [PROMO_PRICING_HEADER]: String(PROMO_PRICING_VERSION) }));

/** Nothing left the process except through the mocks this file handed out. */
async function expectNoSideEffects() {
  // A write started but not awaited by the handler (`void insert()`) lands a
  // few ticks after it returns.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(writes, "a database write before Pay").toEqual([]);
  expect(reslabOther, "a ResLab call that is not a read before Pay").toEqual([]);
  expect(emails, "an email before Pay").not.toHaveBeenCalled();
  expect(fetches, "an outside call before Pay").not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  reslabOther.length = 0;
  for (const key of Object.keys(reads)) delete reads[key];
  // The direct-lot read the real lot lookup makes: no direct lots.
  reads.direct_lots_v2 = [];
  __resetAttributionRateLimitForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T16:00:00Z"));
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
  vi.stubEnv("ENABLE_DIRECT_LOTS", "true");
  vi.stubEnv("ENABLE_RESLAB_LOCATION_SNAPSHOT", "");
  vi.stubGlobal("fetch", fetches.mockRejectedValue(new Error("no network in this test")));

  reslabMock.getLocation.mockImplementation(async (id: number) => ({
    id,
    name: "TEST Lot",
    address: "1 Airport Way",
    city: "Queens",
    latitude: "40.64",
    longitude: "-73.77",
    currency: { code: "USD" },
    photos: [],
    amenities: [],
    extra_fields: [],
    cancellation_policies: [],
  }));
  reslabMock.getMinPrice.mockResolvedValue({
    rates: [{ id: 1, location_parking_type_id: 7, price: 10, from_date: "", to_date: "", number_of_days: 5 }],
    reservation: { ...COST.reservation, totals: { parking: { number_of_days: 5, sub_total: 50 } } },
  });
  reslabMock.getCost.mockResolvedValue(COST);
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

describe("the recorder itself (or the tests below prove nothing)", () => {
  it("on every client the app can build: a read is quiet, anything else is recorded", async () => {
    const server = await import("@/lib/supabase/server");
    const { createClient: createBrowser } = await import("@/lib/supabase/client");
    const clients = [await server.createAdminClient(), await server.createClient(), createBrowser()];
    for (const client of clients) {
      writes.length = 0;
      // The real promo read, and the real direct-lot read.
      await client.from("promo_codes").select("*").eq("code", "X").abortSignal(AbortSignal.timeout(1000)).maybeSingle();
      await client.rpc("direct_lots_v2", {}).abortSignal(AbortSignal.timeout(1000));
      expect(writes).toEqual([]);

      await client.from("pending_bookings").insert({});
      await client.from("promo_codes").update({}).eq("code", "X");
      await client.rpc("increment_promo_use", {});
      await client.auth.signInWithOtp({ email: "ada@example.com" });
      await client.functions.invoke("anything");
      await client.storage.from("bucket").move("a", "b");
      expect(writes).toHaveLength(6);
      expect(writes.join("\n")).toContain("rpc(increment_promo_use)");
    }
  });

  it("a read returns the row the test planted", async () => {
    reads.promo_codes = PROMO_ROW;
    const { createAdminClient } = await import("@/lib/supabase/server");
    const { data } = await (await createAdminClient()).from("promo_codes").select("*").eq("code", "TEN").maybeSingle();
    expect(data).toEqual(PROMO_ROW);
  });
});

describe("before Pay: no database write, no email, no outside call", () => {
  it("GET /api/checkout/lot (loading checkout), through the real lot lookup", async () => {
    const res = await getLot(lotQuery());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lot.name).toBe("TEST Lot");
    expect(body.costData.costsToken).toBe("tok");
    await expectNoSideEffects();
  });

  it("GET /api/checkout/lot when ResLab cannot price the stay (the estimate fallback)", async () => {
    reslabMock.getCost.mockRejectedValueOnce(new Error("staging ResLab is down"));
    const res = await getLot(lotQuery());
    expect(res.status).toBe(200);
    expect((await res.json()).costData.costsToken).toBeNull();
    await expectNoSideEffects();
  });

  it("POST /api/checkout/lot (Continue to Payment), with and without a protection plan", async () => {
    const plain = await postIntent();
    expect(plain.status).toBe(200);
    expect((await plain.json()).chargeCents).toBe(6095);
    // The form sends the kept choice when the customer comes back to this step.
    const withPlan = await postIntent({ protectionPlanCode: "A" });
    expect(withPlan.status).toBe(200);
    expect((await withPlan.json()).chargeCents).toBe(6095 + 1299);
    expect(createPI).toHaveBeenCalledTimes(2);
    await expectNoSideEffects();
  });

  it("POST /api/checkout/lot with a promo code: refused when unknown, applied when found, never counted here", async () => {
    const unknown = await postIntent({ promoCode: "NOPE" });
    expect(unknown.status).toBe(200);
    expect((await unknown.json()).chargeCents).toBe(6095);

    reads.promo_codes = PROMO_ROW;
    const applied = await postIntent({ promoCode: "TEN" });
    expect(applied.status).toBe(200);
    // 10 % off the $50 of parking: the code's use is counted at Pay, not here.
    expect((await applied.json()).chargeCents).toBe(5595);
    await expectNoSideEffects();
  });

  it("POST /api/checkout/lot/update-pi (picking and declining a protection plan)", async () => {
    for (const protectionPlanCode of ["C", null]) {
      const res = await updateIntent(
        jsonPost("http://localhost/api/checkout/lot/update-pi", { paymentIntentId: "pi_smoke", protectionPlanCode })
      );
      expect(res.status).toBe(200);
    }
    expect(stripeMock.paymentIntents.update).toHaveBeenCalledTimes(2);
    await expectNoSideEffects();
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
    await expectNoSideEffects();
  });
});
