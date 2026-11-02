import { describe, expect, it } from "vitest";
import { buildParkStayAccess } from "../access";
import { HOTEL_LOTS, type HotelLotEntry } from "../hotel-lots";

const JFK = { code: "JFK", name: "John F. Kennedy International Airport" };

describe("buildParkStayAccess (CX plan v2 §1)", () => {
  it("lists only enabled hotels at the open airports, with the account's ids", () => {
    const out = buildParkStayAccess([JFK], "production");
    expect(out.airports).toEqual([JFK]);
    expect(out.hotels.map((h) => [h.key, h.reslabLotId])).toEqual([
      ["doubletree-jfk", 132],
      ["hampton-inn-jfk", 304],
    ]);
  });

  it("no account → null ids; a staging account with no staging ids → null ids", () => {
    expect(buildParkStayAccess([JFK], null).hotels.every((h) => h.reslabLotId === null)).toBe(true);
    expect(buildParkStayAccess([JFK], "staging").hotels.every((h) => h.reslabLotId === null)).toBe(true);
  });

  it("a photo off the allowlist is dropped to the placeholder, never served", () => {
    const base = HOTEL_LOTS[0];
    const bad: HotelLotEntry = { ...base, display: { photoUrl: "https://evil.example/x.jpg", shuttle: base.display.shuttle } };
    expect(buildParkStayAccess([JFK], "production", [bad]).hotels[0].photoUrl).toBeNull();
  });
});
