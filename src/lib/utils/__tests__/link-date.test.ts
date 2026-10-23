import { describe, it, expect } from "vitest";
import { linkDate, lotLinkQuery } from "../link-date";

describe("linkDate", () => {
  it("a plain date → itself", () => {
    expect(linkDate("2026-12-05")).toBe("2026-12-05");
  });

  it("a local date and time (TRIPLY-2D's link) → the date part as written", () => {
    expect(linkDate("2026-12-05T18:00")).toBe("2026-12-05");
    expect(linkDate("2026-12-14T02:00:00")).toBe("2026-12-14");
    expect(linkDate("2026-12-14T02:00:00.000")).toBe("2026-12-14");
    expect(linkDate("2026-12-14 02:00")).toBe("2026-12-14");
  });

  it("a UTC instant (Z or offset) → undefined: its written date can be the wrong day", () => {
    expect(linkDate("2026-12-14T02:00:00.000Z")).toBeUndefined(); // Dec 13 in New York
    expect(linkDate("2026-12-14T02:00:00-05:00")).toBeUndefined();
    expect(linkDate("2026-12-14T02:00:00 05:00")).toBeUndefined(); // unencoded "+05:00"
  });

  it("not a real day → undefined; leap days follow the calendar", () => {
    expect(linkDate("2026-02-30")).toBeUndefined();
    expect(linkDate("2026-13-01")).toBeUndefined();
    expect(linkDate("2026-02-30T10:00")).toBeUndefined();
    expect(linkDate("2028-02-29")).toBe("2028-02-29");
    expect(linkDate("2027-02-29")).toBeUndefined();
  });

  it("anything else → undefined, like a link without a date", () => {
    expect(linkDate(undefined)).toBeUndefined();
    expect(linkDate("")).toBeUndefined();
    expect(linkDate("tomorrow")).toBeUndefined();
    expect(linkDate("12/05/2026")).toBeUndefined();
    expect(linkDate("2026-12-05Tgarbage")).toBeUndefined();
    expect(linkDate("2026-12-5")).toBeUndefined();
  });

  it("a repeated param (an array) → undefined, not a crash", () => {
    expect(linkDate(["2026-12-05", "2026-12-06"])).toBeUndefined();
  });
});

describe("lotLinkQuery (what the lot page reads from its link)", () => {
  it("TRIPLY-2D's link → clean dates; times passed through", () => {
    expect(
      lotLinkQuery({ checkin: "2026-12-05T18:00", checkout: "2026-12-14T02:00", checkinTime: "6:00 PM", checkoutTime: undefined })
    ).toEqual({ checkin: "2026-12-05", checkout: "2026-12-14", checkinTime: "6:00 PM", checkoutTime: undefined, ignored: [] });
  });

  it("repeated params of any kind → absent", () => {
    expect(
      lotLinkQuery({ checkin: ["2026-12-05", "x"], checkout: ["a", "b"], checkinTime: ["6:00 PM", "7:00 PM"], checkoutTime: ["1:00 PM"] })
    ).toEqual({ checkin: undefined, checkout: undefined, checkinTime: undefined, checkoutTime: undefined, ignored: ["checkin", "checkout"] });
  });

  it("an unreadable check-in drops the check-out too (never half a range)", () => {
    expect(lotLinkQuery({ checkin: "2026-12-05T18:00Z", checkout: "2026-12-14" })).toMatchObject({
      checkin: undefined,
      checkout: undefined,
      ignored: ["checkin"],
    });
  });

  it("an unreadable check-out alone keeps the check-in", () => {
    expect(lotLinkQuery({ checkin: "2026-12-05", checkout: "garbage" })).toMatchObject({
      checkin: "2026-12-05",
      checkout: undefined,
      ignored: ["checkout"],
    });
  });

  it("absent params aren't 'ignored'", () => {
    expect(lotLinkQuery({}).ignored).toEqual([]);
  });
});
