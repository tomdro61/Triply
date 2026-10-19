import { describe, it, expect } from "vitest";
import { guideLabels } from "../guide-label";

// Real hub/sub-pillar titles from the live CMS (Oct 19, 2026).
describe("guideLabels", () => {
  it.each([
    ["BWI Airport Parking from $6/day: 2026 Rates & Best Lots", "BWI Airport Parking"],
    ["DFW Airport Parking from $5/day: 2026 Guide & Rates", "DFW Airport Parking"],
    ["JFK Airport Parking Deals: Off-Site Lots From About $13/Day", "JFK Airport Parking Deals"],
    ["BWI Hourly Parking: $6/hr, $30 Max + Cheaper Alternatives", "BWI Hourly Parking"],
    ["JFK Airport Parking Off Site: The Complete Guide (2026)", "JFK Airport Parking Off Site"],
    ["DFW Airport Parking Rates & Cost Guide 2026", "DFW Airport Parking Rates & Cost Guide"],
    ["Baltimore Washington Airport Parking Rates 2026: Full Guide", "Baltimore Washington Airport Parking Rates"],
    ["PDX Airport Parking: Complete 2026 Guide to Rates & Lots", "PDX Airport Parking"],
    ["LAX Parking: $8–$75/Day Rates by Lot & Terminal 2026", "LAX Parking: Rates by Lot & Terminal"],
    ["LAX Short-Term Parking: $9/hr Rates + Best Garage Hacks", "LAX Short-Term Parking"],
    ["YYC Parking Promo Code 2026: From C$8.35/Day", "YYC Parking Promo Code"],
  ])("%s → %s", (title, label) => {
    expect(guideLabels([title])).toEqual([label]);
  });

  it("never leaves a price or a year in any label", () => {
    const titles = [
      "BWI Airport Parking from $6/day: 2026 Rates & Best Lots",
      "LAX Parking: $8–$75/Day Rates by Lot & Terminal 2026",
      "BWI Hourly Parking: $6/hr, $30 Max + Cheaper Alternatives",
    ];
    for (const l of guideLabels(titles)) {
      expect(l).not.toMatch(/\$|\b20\d\d\b/);
    }
  });

  it("uses the full cleaned title when two topics collide", () => {
    expect(
      guideLabels([
        "JFK Airport Parking Long Term: Rates, Lots & Best Deals",
        "JFK Airport Parking Long Term: 2026 Economy Lot Guide",
      ])
    ).toEqual([
      "JFK Airport Parking Long Term: Rates, Lots & Best Deals",
      "JFK Airport Parking Long Term: Economy Lot Guide",
    ]);
  });
});
