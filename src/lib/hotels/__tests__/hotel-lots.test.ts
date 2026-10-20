import { describe, it, expect } from "vitest";
import { airports } from "@/config/airports";
import { HOTEL_LOTS, enabledHotelLotsFor, findEnabledHotelLot } from "../hotel-lots";
import { RESLAB_ACCOUNT_BY_FINGERPRINT, reslabAccountForFingerprint, reslabIdFor } from "../reslab-account";
import { distanceMeters } from "../geo";
import { safePhotoUrl } from "../photo-hosts";

/** sha256(production RESLAB_API_KEY)[0:16], as keyFingerprint() computes it. */
const PROD_FINGERPRINT = "f5d7c11622bdb289";

const productionCodes = new Set(airports.filter((a) => a.enabled && !a.isTest).map((a) => a.code));

describe("the hotel ↔ lot map (plan v3 §3.2)", () => {
  it("has the ten seeded NY/NJ hotels", () => {
    expect(HOTEL_LOTS).toHaveLength(10);
  });

  it("keys, ResLab ids and LiteAPI ids are unique", () => {
    const keys = HOTEL_LOTS.map((e) => e.key);
    const prodIds = HOTEL_LOTS.map((e) => e.reslab.ids.production).filter((v) => v !== null);
    const stagingIds = HOTEL_LOTS.map((e) => e.reslab.ids.staging).filter((v) => v !== null);
    const liteIds = HOTEL_LOTS.map((e) => e.liteapi.hotelId);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(prodIds).size).toBe(prodIds.length);
    expect(new Set(stagingIds).size).toBe(stagingIds.length);
    expect(new Set(liteIds).size).toBe(liteIds.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9-]{1,64}$/);
  });

  it("every airport is a production airport", () => {
    for (const e of HOTEL_LOTS) expect(productionCodes.has(e.airport), e.key).toBe(true);
  });

  it("every enabled entry has a hand-check record and a production id", () => {
    for (const e of HOTEL_LOTS.filter((x) => x.enabled)) {
      expect(e.check.by.length, e.key).toBeGreaterThan(0);
      expect(e.check.on, e.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.check.evidence.length, e.key).toBeGreaterThan(20);
      expect(Number.isInteger(e.reslab.ids.production) && (e.reslab.ids.production ?? 0) > 0, e.key).toBe(true);
    }
  });

  it("coordinates are finite, and each lot lies near its hotel (≤ 150 m — the check found 10–84 m)", () => {
    for (const e of HOTEL_LOTS) {
      for (const v of [e.reslab.latitude, e.reslab.longitude, e.liteapi.latitude, e.liteapi.longitude]) expect(Number.isFinite(v), e.key).toBe(true);
      expect(distanceMeters(e.reslab.latitude, e.reslab.longitude, e.liteapi.latitude, e.liteapi.longitude), e.key).toBeLessThanOrEqual(150);
    }
  });

  it("disabledReason is set exactly when enabled is false; Red Carpet is disabled (D2)", () => {
    for (const e of HOTEL_LOTS) {
      expect(e.disabledReason === null, e.key).toBe(e.enabled);
      if (e.disabledReason !== null) expect(e.disabledReason.trim().length).toBeGreaterThan(0);
    }
    const redCarpet = HOTEL_LOTS.find((e) => e.reslab.ids.production === 184);
    expect(redCarpet?.enabled).toBe(false);
    expect(redCarpet?.disabledReason).toMatch(/D2/);
  });

  it("the preview allowlist (JFK, LGA, EWR) and the map agree: each has an enabled hotel", () => {
    expect(enabledHotelLotsFor("JFK").map((e) => e.reslab.ids.production)).toEqual([132, 304]);
    expect(enabledHotelLotsFor("lga").map((e) => e.reslab.ids.production)).toEqual([159, 454]);
    expect(enabledHotelLotsFor("EWR")).toHaveLength(5);
    expect(new Set(HOTEL_LOTS.map((e) => e.airport))).toEqual(new Set(["JFK", "LGA", "EWR"]));
  });

  it("display: every photo is an allowlisted https URL (or null) and every shuttle line is short and never says 'free' (CX plan §5)", () => {
    for (const e of HOTEL_LOTS) {
      if (e.display.photoUrl !== null) expect(safePhotoUrl(e.display.photoUrl).url, e.key).toBe(e.display.photoUrl);
      expect(e.display.shuttle.trim().length, e.key).toBeGreaterThan(0);
      expect(e.display.shuttle.length, e.key).toBeLessThanOrEqual(60);
      expect(/\bfree\b/i.test(e.display.shuttle), e.key).toBe(false);
    }
    // Enabled hotels all have a photo (copied from the 19 Oct sandbox answer).
    expect(HOTEL_LOTS.filter((e) => e.enabled && e.display.photoUrl === null)).toEqual([]);
    // The one hotel with no shuttle is the disabled one (D2).
    expect(HOTEL_LOTS.filter((e) => /no airport shuttle/i.test(e.display.shuttle)).map((e) => e.key)).toEqual(["red-carpet-inn-ewr"]);
  });

  it("findEnabledHotelLot refuses unknown, disabled and other-airport keys", () => {
    expect(findEnabledHotelLot("JFK", "doubletree-jfk")?.reslab.ids.production).toBe(132);
    expect(findEnabledHotelLot("LGA", "doubletree-jfk")).toBeNull();
    expect(findEnabledHotelLot("EWR", "red-carpet-inn-ewr")).toBeNull();
    expect(findEnabledHotelLot("JFK", "nope")).toBeNull();
  });
});

describe("ResLab account selection (§9.3)", () => {
  it("maps the production fingerprint to production", () => {
    expect(reslabAccountForFingerprint(PROD_FINGERPRINT)).toBe("production");
  });

  it("an unknown or missing fingerprint fails closed", () => {
    expect(reslabAccountForFingerprint("0000000000000000")).toBeNull();
    expect(reslabAccountForFingerprint(null)).toBeNull();
    expect(reslabAccountForFingerprint("toString")).toBeNull();
  });

  it("every table value is a known account and every key a 16-hex fingerprint", () => {
    for (const [fp, account] of Object.entries(RESLAB_ACCOUNT_BY_FINGERPRINT)) {
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
      expect(["production", "staging"]).toContain(account);
    }
  });

  it("chooses the id BY account; a null staging id is unavailable, never the production id", () => {
    const e = HOTEL_LOTS[0];
    expect(reslabIdFor(e, "production")).toBe(e.reslab.ids.production);
    expect(reslabIdFor(e, "staging")).toBeNull();
  });
});
