import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_RESLAB_LOCATION_IDS } from "@/config/admin";
import {
  BLOCKED_RESLAB_LOCATION_IDS,
  hiddenReslabLocationIds,
  isHiddenReslabLocation,
} from "@/lib/reslab/search";

// ResLab's test lots (194–197) are real listings in the production channel.
// They surfaced in production search under CVG/YUL and in the sitemap on
// 2026-11-02. Production hides them; preview/staging/development keep them
// for test bookings.
describe("hiddenReslabLocationIds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("production hides the blocked list AND the test lots", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    const hidden = hiddenReslabLocationIds();
    for (const id of BLOCKED_RESLAB_LOCATION_IDS) expect(hidden.has(id)).toBe(true);
    for (const id of TEST_RESLAB_LOCATION_IDS) expect(hidden.has(id)).toBe(true);
    expect(isHiddenReslabLocation(194)).toBe(true);
    expect(isHiddenReslabLocation(196)).toBe(true);
    expect(isHiddenReslabLocation(416)).toBe(true);
    expect(isHiddenReslabLocation(422)).toBe(false); // a real lot (Broadway Motor Service, BOS)
  });

  it.each(["preview", "staging", "development"])("%s keeps the test lots bookable, still hides the blocked list", (env) => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", env);
    expect(isHiddenReslabLocation(194)).toBe(false);
    expect(isHiddenReslabLocation(197)).toBe(false);
    expect(isHiddenReslabLocation(416)).toBe(true);
    expect(hiddenReslabLocationIds()).toBe(BLOCKED_RESLAB_LOCATION_IDS);
  });

  it("an unknown environment fails closed (hides the test lots)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(isHiddenReslabLocation(195)).toBe(true);
  });

  it("falls back to VERCEL_ENV when NEXT_PUBLIC_APP_ENV is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(isHiddenReslabLocation(194)).toBe(false);
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isHiddenReslabLocation(194)).toBe(true);
  });
});
