import { describe, it, expect, afterEach } from "vitest";
import { parkStayFlags, isParkStayEnabledFor, __resetParkStayFlagsForTests } from "../flags";
import { resolveHotelEnv, liteApiModeFromEnv, LiteApiConfigError } from "../liteapi/env";

describe("park & stay flags", () => {
  const saved = { ENABLE_PARK_STAY: process.env.ENABLE_PARK_STAY, PARK_STAY_AIRPORTS: process.env.PARK_STAY_AIRPORTS };
  afterEach(() => {
    process.env.ENABLE_PARK_STAY = saved.ENABLE_PARK_STAY;
    process.env.PARK_STAY_AIRPORTS = saved.PARK_STAY_AIRPORTS;
    __resetParkStayFlagsForTests();
  });

  it("is OFF by default, OFF with the master on but no airports, OFF with airports but no master", () => {
    delete process.env.ENABLE_PARK_STAY;
    delete process.env.PARK_STAY_AIRPORTS;
    __resetParkStayFlagsForTests();
    expect(parkStayFlags().enabled).toBe(false);

    process.env.ENABLE_PARK_STAY = "true";
    __resetParkStayFlagsForTests();
    expect(parkStayFlags().enabled).toBe(false);

    delete process.env.ENABLE_PARK_STAY;
    process.env.PARK_STAY_AIRPORTS = "JFK";
    __resetParkStayFlagsForTests();
    expect(isParkStayEnabledFor("JFK")).toBe(false);
  });

  it("is on only for the allowlisted airports, case-insensitively, ignoring junk entries", () => {
    process.env.ENABLE_PARK_STAY = "true";
    process.env.PARK_STAY_AIRPORTS = " jfk, LGA ,ewrx,, 12";
    __resetParkStayFlagsForTests();
    expect(isParkStayEnabledFor("jfk")).toBe(true);
    expect(isParkStayEnabledFor("LGA")).toBe(true);
    expect(isParkStayEnabledFor("EWR")).toBe(false);
    expect(isParkStayEnabledFor("BOS")).toBe(false);
  });
});

describe("LiteAPI env — mode follows Stripe live-mode, never falls back across modes", () => {
  it("derives the mode from the Stripe key prefix", () => {
    expect(liteApiModeFromEnv({ STRIPE_SECRET_KEY: "sk_live_x" })).toBe("live");
    expect(liteApiModeFromEnv({ STRIPE_SECRET_KEY: "sk_test_x" })).toBe("sandbox");
    expect(liteApiModeFromEnv({})).toBe("sandbox");
  });

  it("live Stripe + only a sandbox key THROWS instead of booking sandbox rooms in production", () => {
    expect(() => resolveHotelEnv({ STRIPE_SECRET_KEY: "sk_live_x", LITEAPI_SANDBOX_KEY: "sand" })).toThrow(LiteApiConfigError);
  });

  it("selects the key for the mode and both hosts", () => {
    const e = resolveHotelEnv({ STRIPE_SECRET_KEY: "sk_test_x", LITEAPI_SANDBOX_KEY: " sand " });
    expect(e).toEqual({
      mode: "sandbox",
      apiKey: "sand",
      dataBaseUrl: "https://api.liteapi.travel/v3.0",
      bookBaseUrl: "https://book.liteapi.travel/v3.0",
    });
    const live = resolveHotelEnv({ STRIPE_SECRET_KEY: "sk_live_x", LITEAPI_API_KEY: "prod", LITEAPI_SANDBOX_KEY: "sand" });
    expect(live.mode).toBe("live");
    expect(live.apiKey).toBe("prod");
  });
});
