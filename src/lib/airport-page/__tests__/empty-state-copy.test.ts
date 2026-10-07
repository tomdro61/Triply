import { describe, it, expect } from "vitest";
import { emptyStateCopy } from "../content";

describe("airport page empty-state copy", () => {
  it("says coming soon only when we list no lots there", () => {
    const c = emptyStateCopy("Boise Airport", 0);
    expect(c.heading).toBe("Parking Options Coming Soon");
    expect(c.body).toContain("Boise Airport");
  });

  it("says no availability (never coming soon) at an airport we serve that is booked up", () => {
    const c = emptyStateCopy("Washington Dulles International", 3);
    expect(c.heading).toBe("No Online Availability for the Next Week");
    expect(c.body).toContain("Washington Dulles International");
    expect(`${c.heading} ${c.body}`).not.toMatch(/coming soon|expanding/i);
  });

  it("claims nothing when the count is unknown", () => {
    const c = emptyStateCopy("Boise Airport", null);
    expect(c.heading).toContain("Boise Airport");
    expect(c.body).toMatch(/search/i);
    expect(`${c.heading} ${c.body}`).not.toMatch(/coming soon|expanding|booked|unavailable/i);
  });

  it("puts no dates in the copy (pages can be served stale)", () => {
    for (const n of [0, 2, null]) {
      const { heading, body } = emptyStateCopy("X", n);
      expect(`${heading} ${body}`).not.toMatch(
        /\b(\d{4}|\d{1,2}\/\d{1,2}|jan(uary)?|feb(ruary)?|march|apr(il)?|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|tomorrow|today|tonight|(mon|tues|wednes|thurs|fri|satur|sun)day)\b/i,
      );
    }
  });
});
