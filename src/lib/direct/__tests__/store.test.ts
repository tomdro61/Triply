/**
 * The direct-lot store: the one place that turns `public.direct_lots()` rows
 * into app objects, decides what is sellable, and gives callers a TYPED
 * failure. Unit tests use a fixture in the function's exact column shape; the
 * opt-in integration test pins that shape against the LIVE function.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { adminClient, sentry } = await vi.hoisted(async () => ({
  adminClient: { rpc: vi.fn() },
  sentry: { captureAPIError: vi.fn() },
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => adminClient }));
vi.mock("@/lib/sentry", () => sentry);

import {
  directLotFromRow,
  isSellable,
  parseDirectLotUnifiedId,
  directLotUnifiedId,
  fetchDirectLots,
  fetchDirectLot,
  DIRECT_LOT_ROW_KEYS,
  __resetCaptureThrottleForTests,
} from "../store";

/** Exactly what `public.direct_lots_v2()` returns for The Parking Point JFK (migration 036). */
const row = {
  id: 1,
  name: "The Parking Point JFK",
  slug: "the-parking-point-jfk",
  airport_code: "JFK",
  reslab_location_id: null,
  description_short: "Fenced 24-hour lot",
  content: null,
  seo_meta_title: null,
  seo_meta_description: null,
  featured_image_url: "/api/media/file/lot.jpg",
  featured_image_alt: "Entrance",
  gallery_urls: ["/api/media/file/a.jpg", null],
  distance_to_terminal_minutes: 10,
  shuttle_details: "Every 15–20 min, 24/7",
  shuttle_phone: "+1 (347) 960-7065",
  address_street: "150-57 183rd St",
  address_city: "Springfield Gardens",
  address_state: "NY",
  address_zip: "11413",
  lat: 40.6568,
  lng: -73.7644,
  booking_instructions: { beforeArrival: null, whenYouArrive: "Show your confirmation", importantNotes: null, whenYouReturn: null, gettingToAirport: "Shuttle 24/7" },
  faqs: [],
  amenities: [{ id: 1, name: "Shuttle", icon: "bus" }],
  is_active: true,
  visibility: "staging_only",
  min_stay_days: 1,
  min_lead_hours: 2,
  base_daily_rate: 9.95,
  tax_rate_percent: 10.375,
  tax_collected_by: "lot",
  partner_share_percent: 80,
  notification_emails: ["tom@triplypro.com"],
  status: "published",
  published_at: null,
  updated_at: "2026-10-05T20:00:00.000Z",
  vehicle_surcharges: [
    { code: "small_suv", label: "Small SUV", dailyRate: 5 },
    { code: "midsize_suv", label: "Midsize SUV / minivan", dailyRate: 7 },
    { code: "large_suv_truck", label: "Large SUV / truck", dailyRate: 10 },
  ],
};

/** Simulates the supabase-js rpc builder: `.rpc(...).abortSignal(...)` resolves to `{ data, error }`. */
const rpcResolves = (result: { data?: unknown; error?: unknown }) =>
  adminClient.rpc.mockReturnValue({ abortSignal: async () => ({ data: result.data ?? null, error: result.error ?? null }) });

beforeEach(() => {
  adminClient.rpc.mockReset();
  sentry.captureAPIError.mockReset();
  __resetCaptureThrottleForTests();
});

describe("directLotFromRow", () => {
  it("the fixture has exactly the function's columns (keeps this file honest when 035 changes)", () => {
    expect(Object.keys(row).sort()).toEqual(DIRECT_LOT_ROW_KEYS);
  });

  it("maps a function row to a DirectLot with airport-derived timezone, cents, resolved image URLs", () => {
    const out = directLotFromRow(row);
    expect(out.lot).not.toBeNull();
    const lot = out.lot!;
    expect(lot.id).toBe("direct-1");
    expect(lot.timezone).toBe("America/New_York");
    expect(lot.rateCents).toBe(995);
    expect(lot.featuredImage?.url).toMatch(/^http.*\/api\/media\/file\/lot\.jpg$/);
    expect(lot.galleryUrls).toHaveLength(1); // the NULL (mid-upload) entry is dropped, not fatal
    expect(lot.galleryUrls[0].startsWith("http")).toBe(true);
    expect(lot.address).toEqual({ street: "150-57 183rd St", city: "Springfield Gardens", state: "NY", zip: "11413" });
    expect(lot.taxCollectedBy).toBe("lot");
    expect(lot.partnerSharePercent).toBe(80);
  });

  it("accepts numeric strings (node-postgres) but never coerces null or '' into 0", () => {
    expect(directLotFromRow({ ...row, lat: "40.6568", base_daily_rate: "9.95", partner_share_percent: "80" }).lot?.rateCents).toBe(995);
    for (const k of ["lat", "lng", "tax_rate_percent", "partner_share_percent", "base_daily_rate"]) {
      expect(directLotFromRow({ ...row, [k]: null }).lot, `${k}=null`).toBeNull();
      expect(directLotFromRow({ ...row, [k]: "" }).lot, `${k}=''`).toBeNull();
    }
  });

  it.each([
    ["unknown airport", { ...row, airport_code: "ZZZ" }, /not configured/],
    ["unknown visibility", { ...row, visibility: "everyone" }, /visibility/],
    ["a missing required column", { ...row, address_street: undefined }, /shape/],
    ["a non-positive rate", { ...row, base_daily_rate: 0 }, /shape/],
    ["an unexpected tax collector", { ...row, tax_collected_by: "nobody" }, /shape/],
    ["an unexpected extra column (function/module drift)", { ...row, surprise: 1 }, /shape/],
  ])("drops a row with %s instead of guessing", (_label, bad, reason) => {
    const out = directLotFromRow(bad);
    expect(out.lot).toBeNull();
    if (!out.lot) expect(out.reason).toMatch(reason);
  });

  it("drop reasons name the field, never the value", () => {
    const out = directLotFromRow({ ...row, address_zip: "" });
    expect(out.lot).toBeNull();
    if (!out.lot) {
      expect(out.reason).toMatch(/address_zip/);
      expect(out.reason).not.toMatch(/11413|Springfield/);
    }
  });
});

describe("isSellable", () => {
  const lot = directLotFromRow(row).lot!;
  it.each([
    ["staging_only lot in staging", lot, "staging", true],
    ["staging_only lot in production", lot, "production", false],
    ["staging_only lot in unknown env", lot, "unknown", false],
    ["production lot in production", { ...lot, visibility: "production" as const }, "production", true],
    ["inactive", { ...lot, isActive: false }, "staging", false],
    ["draft", { ...lot, status: "draft" as const }, "staging", false],
  ])("%s → %s", (_l, l, env, expected) => {
    expect(isSellable(l, env)).toBe(expected);
  });

  it("defaults the environment to resolveEnv() so a caller cannot forget it", () => {
    const saved = { app: process.env.NEXT_PUBLIC_APP_ENV, vercel: process.env.VERCEL_ENV };
    delete process.env.NEXT_PUBLIC_APP_ENV;
    delete process.env.VERCEL_ENV;
    try {
      expect(isSellable(lot)).toBe(false); // unknown env → fails closed
      process.env.NEXT_PUBLIC_APP_ENV = "staging";
      expect(isSellable(lot)).toBe(true);
      process.env.NEXT_PUBLIC_APP_ENV = "production";
      expect(isSellable(lot)).toBe(false);
    } finally {
      if (saved.app === undefined) delete process.env.NEXT_PUBLIC_APP_ENV; else process.env.NEXT_PUBLIC_APP_ENV = saved.app;
      if (saved.vercel === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved.vercel;
    }
  });
});

describe("fetchDirectLots — typed failures, throttled reporting", () => {
  it("returns parsed lots, uppercases the airport filter, and drops bad rows with ONE report", async () => {
    rpcResolves({ data: [row, { ...row, id: 2, slug: "broken", lat: null }] });
    const r = await fetchDirectLots({ airportCode: "jfk" });
    expect(adminClient.rpc).toHaveBeenCalledWith("direct_lots_v2", { p_airport_code: "JFK", p_id: null });
    expect(r.ok && r.lots.map((l) => l.id)).toEqual(["direct-1"]);
    expect(r.ok && r.dropped).toBe(1);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    expect(sentry.captureAPIError.mock.calls[0][1]).toMatchObject({ stage: "direct_lots_parse" });
  });

  it.each([
    ["permission denied", { code: "42501", message: "permission denied for function direct_lots" }, "misconfigured"],
    ["function missing", { code: "PGRST202", message: "Could not find the function" }, "misconfigured"],
    ["timeout", { code: "", message: "TimeoutError: The operation was aborted due to timeout" }, "timeout"],
    ["column renamed under the function (schema drift)", { code: "42703", message: "column l.base_daily_rate does not exist" }, "misconfigured"],
    ["column type changed (RETURN QUERY shape)", { code: "42804", message: "structure of query does not match function result type" }, "misconfigured"],
    ["anything else", { code: "XX000", message: "boom" }, "unavailable"],
  ])("%s → kind %s with the code preserved", async (_l, error, kind) => {
    rpcResolves({ error });
    const r = await fetchDirectLots();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe(kind);
      expect(r.code).toBe(error.code);
    }
    // First time this (stage, kind, code) is seen on the instance → one capture.
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    expect(sentry.captureAPIError.mock.calls[0][1]).toMatchObject({ stage: "direct_lots_read" });
  });

  it("a non-array response is unavailable, not zero lots", async () => {
    rpcResolves({ data: { oops: true } });
    const r = await fetchDirectLots();
    expect(r).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("the same failure is captured once per 5 minutes per instance, with the suppressed count", async () => {
    vi.useFakeTimers();
    try {
      rpcResolves({ error: { code: "42501", message: "permission denied for function direct_lots" } });
      await fetchDirectLots();
      await fetchDirectLots();
      await fetchDirectLots();
      expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await fetchDirectLots();
      expect(sentry.captureAPIError).toHaveBeenCalledTimes(2);
      expect(sentry.captureAPIError.mock.calls[1][1]).toMatchObject({ extra: expect.objectContaining({ suppressedSinceLastCapture: 2 }) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("two lots broken for DIFFERENT reasons each get their own event", async () => {
    rpcResolves({ data: [{ ...row, id: 2, lat: null }, { ...row, id: 3, tax_collected_by: "nobody" }] });
    const r = await fetchDirectLots();
    expect(r.ok && r.dropped).toBe(2);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(2);
  });

  it("names the broken rows (id / slug / airport read leniently) so a lookup can tell THIS lot is broken from 'no such lot'", async () => {
    rpcResolves({ data: [{ ...row, id: "2", slug: "broken-lot", airport_code: "jfk", lat: null }, { ...row, id: 3, slug: 7, address_zip: "" }] });
    const r = await fetchDirectLots();
    expect(r.ok && r.droppedKeys).toEqual([
      { id: 2, slug: "broken-lot", airportCode: "JFK" },
      { id: 3, slug: null, airportCode: "JFK" },
    ]);
  });

  it("a row at an airport the site does not list is UNLISTED, not dropped — it can never make a miss a 503", async () => {
    rpcResolves({ data: [row, { ...row, id: 2, slug: "elsewhere", airport_code: "ZZZ" }] });
    const r = await fetchDirectLots();
    expect(r.ok && r.lots.map((l) => l.id)).toEqual(["direct-1"]);
    expect(r.ok && r.dropped).toBe(0);
    expect(r.ok && r.droppedKeys).toEqual([]);
    expect(sentry.captureAPIError.mock.calls[0][1]).toMatchObject({ stage: "direct_lots_unlisted" });
  });
});

describe("fetchDirectLot — found / not_found / invalid / unavailable", () => {
  it("found", async () => {
    rpcResolves({ data: [row] });
    const r = await fetchDirectLot(1);
    expect(r.status).toBe("found");
    expect(adminClient.rpc).toHaveBeenCalledWith("direct_lots_v2", { p_airport_code: null, p_id: 1 });
  });
  it("not_found when the function returns nothing", async () => {
    rpcResolves({ data: [] });
    expect((await fetchDirectLot(99)).status).toBe("not_found");
  });
  it("invalid (never not_found) when the row exists but does not parse", async () => {
    rpcResolves({ data: [{ ...row, tax_collected_by: "nobody" }] });
    expect((await fetchDirectLot(1)).status).toBe("invalid");
  });
  it("unavailable carries the kind", async () => {
    rpcResolves({ error: { code: "", message: "TimeoutError: aborted" } });
    expect(await fetchDirectLot(1)).toMatchObject({ status: "unavailable", kind: "timeout" });
  });
  it("a non-positive or fractional id is not_found without a query", async () => {
    expect((await fetchDirectLot(0)).status).toBe("not_found");
    expect((await fetchDirectLot(1.5)).status).toBe("not_found");
    expect(adminClient.rpc).not.toHaveBeenCalled();
  });
});

describe("unified ids", () => {
  it("round-trips and rejects everything that is not canonical direct-<int>", () => {
    expect(directLotUnifiedId(7)).toBe("direct-7");
    expect(parseDirectLotUnifiedId("direct-7")).toBe(7);
    expect(parseDirectLotUnifiedId("direct-007")).toBeNull();
    expect(parseDirectLotUnifiedId("reslab-7")).toBeNull();
    expect(parseDirectLotUnifiedId("direct-")).toBeNull();
    expect(parseDirectLotUnifiedId("direct-7x")).toBeNull();
    expect(parseDirectLotUnifiedId("7")).toBeNull();
  });
});

/**
 * Pins the LIVE function's row shape. Opt-in: `DIRECT_LOTS_INTEGRATION=1 npx vitest run
 * src/lib/direct` — it loads the real .env.local (vitest.setup.ts points Supabase at
 * a fake host for unit tests, so the ordinary env cannot be trusted here). A Payload
 * column rename or an edit to migration 036 that changes a column fails this test.
 */
describe.skipIf(process.env.DIRECT_LOTS_INTEGRATION !== "1")(
  "integration: public.direct_lots_v2() via supabase-js",
  () => {
    it("the live row shape equals the schema, every row parses, and the JFK test lot is staging-only", async () => {
      const { config } = await import("dotenv");
      const real: Record<string, string> = {};
      config({ path: ".env.local", processEnv: real });
      expect(real.NEXT_PUBLIC_SUPABASE_URL, "needs .env.local").toMatch(/^https:\/\/.+supabase\.co/);
      const { createClient } = await import("@supabase/supabase-js");
      const sb = createClient(real.NEXT_PUBLIC_SUPABASE_URL, real.SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await sb.rpc("direct_lots_v2", { p_airport_code: null, p_id: null }).abortSignal(AbortSignal.timeout(8000));
      expect(error).toBeNull();
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      expect(rows.length, "expected at least the JFK test lot").toBeGreaterThan(0);
      expect(Object.keys(rows[0]).sort()).toEqual(DIRECT_LOT_ROW_KEYS);
      const parsed = rows.map(directLotFromRow);
      expect(parsed.filter((p) => !p.lot).map((p) => (p.lot ? "" : p.reason))).toEqual([]);
      const jfk = parsed.map((p) => p.lot!).find((l) => l.slug === "the-parking-point-jfk");
      expect(jfk, "The Parking Point JFK must exist").toBeDefined();
      expect(jfk!.visibility).toBe("staging_only");
      expect(isSellable(jfk!, "staging")).toBe(true);
      expect(isSellable(jfk!, "production")).toBe(false);
      // The live CMS rows (2026-10-09): paid at the lot, never online.
      expect(jfk!.vehicleSurcharges.map((v) => [v.code, v.dailyRateCents])).toEqual([
        ["small_suv", 500],
        ["midsize_suv", 700],
        ["large_suv_truck", 1000],
      ]);
    }, 15_000);
  },
);
