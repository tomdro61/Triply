import { describe, expect, it } from "vitest";
import { unavailableCopy } from "../hotel-detail";

describe("hotel page unavailable copy (review pass 3, M2)", () => {
  it("only an explicit sell-out says 'no Park & Stay available'; an absent hotel is neutral", () => {
    expect(unavailableCopy("parking_sold_out", "DoubleTree")).toBe("DoubleTree has no Park & Stay available for these dates.");
    expect(unavailableCopy("no_room", "DoubleTree")).toMatch(/no Park & Stay available/);
    expect(unavailableCopy("no_rates_returned", "DoubleTree")).toBe("No rooms were returned for these dates.");
    expect(unavailableCopy("lot_moved", "DoubleTree")).not.toMatch(/no Park & Stay available/);
  });
});
