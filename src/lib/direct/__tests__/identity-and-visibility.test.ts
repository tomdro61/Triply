import { describe, it, expect } from "vitest";
import {
  issueConfirmationNumber,
  isTriplyConfirmationNumber,
  isReslabConfirmationNumber,
  TRIPLY_CONFIRMATION_RE,
} from "../confirmation-number";
import { isDirectLotVisible, parseVisibility } from "../visibility";
import { parseLotSnapshot } from "../lot-snapshot";

describe("confirmation numbers", () => {
  it("issues TRP- + 8 Crockford base32 chars, never I/L/O/U", () => {
    for (let i = 0; i < 200; i++) {
      const n = issueConfirmationNumber();
      expect(n).toMatch(TRIPLY_CONFIRMATION_RE);
      expect(n).not.toMatch(/[ILOU]/);
    }
  });

  it("is deterministic for given bytes and uses every alphabet position", () => {
    expect(issueConfirmationNumber(() => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBe("TRP-01234567");
    expect(issueConfirmationNumber(() => new Uint8Array([31, 32, 63, 64, 95, 96, 127, 255]))).toBe("TRP-Z0Z0Z0ZZ");
  });

  it("tells the two sources apart and rejects everything else", () => {
    expect(isTriplyConfirmationNumber("TRP-8K2M4N7P")).toBe(true);
    expect(isTriplyConfirmationNumber("RTL856901")).toBe(false);
    expect(isReslabConfirmationNumber("RTL856901")).toBe(true);
    expect(isReslabConfirmationNumber("TRP-8K2M4N7P")).toBe(false);
    expect(isTriplyConfirmationNumber("trp-8k2m4n7p")).toBe(false);
    expect(isTriplyConfirmationNumber("TRP-8K2M4N7")).toBe(false);
    expect(isTriplyConfirmationNumber("TRP-8K2M4N7I")).toBe(false); // I is not in the alphabet
  });
});

describe("direct lot visibility — fails closed", () => {
  it.each([
    ["production", "production", true],
    ["production", "staging", true],
    ["production", "preview", true],
    ["production", "development", true],
    ["staging_only", "production", false],
    ["staging_only", "staging", true],
    ["staging_only", "preview", true],
    ["staging_only", "development", true],
    ["production", "unknown", false],
    ["staging_only", "unknown", false],
    ["production", "", false],
    ["everyone", "production", false],
    [null, "staging", false],
  ])("visibility=%s env=%s → %s", (vis, env, expected) => {
    expect(isDirectLotVisible(vis, env)).toBe(expected);
  });

  it("parseVisibility accepts only the two known values", () => {
    expect(parseVisibility("production")).toBe("production");
    expect(parseVisibility("Production")).toBeNull();
    expect(parseVisibility(undefined)).toBeNull();
  });
});

describe("lot snapshot schema", () => {
  const good = {
    v: 1,
    directLotId: "7",
    name: "Test Lot LGA",
    slug: "test-lot-lga",
    airportCode: "LGA",
    timezone: "America/New_York",
    address: { street: "1 Test Way", city: "Queens", state: "NY", zip: "11371" },
    coordinates: { lat: 40.77, lng: -73.87 },
    shuttleDetails: null,
    shuttlePhone: null,
    bookingInstructions: { beforeArrival: null, whenYouArrive: "Park and hand keys to the attendant", importantNotes: null, whenYouReturn: null, gettingToAirport: null },
    visibility: "staging_only",
    rateCents: 1595,
    taxRatePercent: 18.375,
    taxCollectedBy: "triply",
    minStayDays: 1,
    minLeadHours: 2,
    notificationEmails: ["ops@triplypro.com"],
  };

  it("accepts a complete v1 snapshot", () => {
    expect(parseLotSnapshot(good)?.directLotId).toBe("7");
  });

  it.each([
    ["unknown version", { ...good, v: 2 }],
    ["no recipients", { ...good, notificationEmails: [] }],
    ["bad email", { ...good, notificationEmails: ["not-an-email"] }],
    ["zero rate", { ...good, rateCents: 0 }],
    ["fractional cents", { ...good, rateCents: 15.95 }],
    ["missing tax collector", { ...good, taxCollectedBy: undefined }],
    ["lowercase airport", { ...good, airportCode: "lga" }],
    ["unknown visibility", { ...good, visibility: "everyone" }],
    ["missing street", { ...good, address: { ...good.address, street: "" } }],
    ["partner share leaked into the snapshot", { ...good, partnerSharePercent: 80 }],
  ])("rejects %s", (_label, bad) => {
    expect(parseLotSnapshot(bad)).toBeNull();
  });
});
