import { describe, expect, it } from "vitest";
import type { ParkStayAccess } from "@/lib/hotels/access";
import { validateParkStayWindow } from "@/lib/hotels/parking-window";
import {
  NEEDS_NIGHT_BEFORE,
  NIGHT_TOO_FAR,
  RETURN_TOO_FAR,
  lotBadgeHref,
  openAirportFor,
  parkStayFromParking,
  type FromParking,
} from "../entry/from-parking";

/**
 * /search → /park-stay (CX plan §12.1, §11, R12-H3, R12-M7): hotel check-in
 * = parking check-in − 1, parking return = parking check-out; disabled on a
 * same-day search, outside the Park & Stay window, or with a return more than
 * 60 days after the night; never throws on bad input.
 */

const ACCESS: ParkStayAccess = {
  airports: [
    { code: "JFK", name: "JFK Airport" },
    { code: "EWR", name: "Newark" },
  ],
  hotels: [
    { key: "doubletree-jfk", airport: "JFK", reslabLotId: 132, name: "DoubleTree", photoUrl: null, shuttle: "Shuttle 24/7" },
    { key: "staging-only", airport: "JFK", reslabLotId: null, name: "No id here", photoUrl: null, shuttle: "Shuttle" },
    { key: "hilton-newark-airport", airport: "EWR", reslabLotId: 320, name: "Hilton Newark", photoUrl: null, shuttle: "Shuttle" },
  ],
};

/** 21 Oct 2026, 3 PM in New York (19:00 UTC). */
const NOW = new Date("2026-10-21T19:00:00Z");
const run = (checkin: string | null, checkout: string | null, airport: string | null = "JFK", now: Date = NOW) =>
  parkStayFromParking({ airport, checkin, checkout }, ACCESS, now);

describe("parkStayFromParking — the mapping", () => {
  it("night = check-in − 1, return = check-out, in the /park-stay key order", () => {
    expect(run("2026-11-11", "2026-11-14")).toEqual({
      kind: "enabled",
      airport: "JFK",
      href: "/park-stay?airport=JFK&night=2026-11-10&returnDate=2026-11-14",
      parkingHref: "/search?airport=JFK&checkin=2026-11-11&checkout=2026-11-14",
    });
  });

  it("is calendar arithmetic across a month end, a year end, a leap day and both DST weekends", () => {
    const cases: Array<[string, string]> = [
      ["2026-11-01", "2026-10-31"],
      ["2026-11-02", "2026-11-01"], // DST ends on 1 Nov 2026
      ["2027-01-01", "2026-12-31"],
      ["2027-03-15", "2027-03-14"], // DST starts on 14 Mar 2027 (inside the 100-day window from a later "now")
      ["2028-03-01", "2028-02-29"],
    ];
    for (const [checkin, night] of cases) {
      const now = new Date(`${night}T15:00:00Z`); // the night itself is "today": the earliest valid case
      const side = run(checkin, checkin, "JFK", now);
      expect(side.kind, checkin).toBe("enabled");
      if (side.kind === "enabled") expect(new URLSearchParams(side.href.split("?")[1]).get("night")).toBe(night);
    }
  });

  it("check-in today → disabled with the reason; check-in tomorrow → a valid night of today", () => {
    expect(run("2026-10-21", "2026-10-25")).toMatchObject({ kind: "disabled", reason: NEEDS_NIGHT_BEFORE });
    expect(run("2026-10-20", "2026-10-25")).toMatchObject({ kind: "disabled", reason: NEEDS_NIGHT_BEFORE });
    const tomorrow = run("2026-10-22", "2026-10-25");
    expect(tomorrow.kind).toBe("enabled");
    if (tomorrow.kind === "enabled") expect(tomorrow.href).toContain("night=2026-10-21");
  });

  it("'today' is the AIRPORT's day, not UTC's", () => {
    // 22 Oct 02:30 UTC is still 21 Oct (10:30 PM) in New York: check-in 22 Oct → night 21 Oct = today there.
    const lateEvening = new Date("2026-10-22T02:30:00Z");
    expect(run("2026-10-22", "2026-10-25", "JFK", lateEvening).kind).toBe("enabled");
    // …and once it is 22 Oct in New York, the same search is same-day.
    expect(run("2026-10-22", "2026-10-25", "JFK", new Date("2026-10-22T05:00:00Z"))).toMatchObject({ kind: "disabled" });
  });

  it("a night beyond the Park & Stay window (today + 100) → disabled", () => {
    // today 2026-10-21 → the last night is 2027-01-29.
    expect(run("2027-01-30", "2027-02-02").kind).toBe("enabled");
    expect(run("2027-01-31", "2027-02-02")).toMatchObject({ kind: "disabled", reason: NIGHT_TOO_FAR });
  });

  it("a return more than 60 days after the night → disabled; exactly 60 → enabled", () => {
    expect(run("2026-11-11", "2027-01-09").kind).toBe("enabled"); // night 11-10 + 60 = 2027-01-09
    expect(run("2026-11-11", "2027-01-10")).toMatchObject({ kind: "disabled", reason: RETURN_TOO_FAR });
  });

  it("every enabled answer passes the server's own window rules", () => {
    for (const [ci, co] of [
      ["2026-10-22", "2026-10-22"],
      ["2026-11-11", "2027-01-09"],
      ["2027-01-30", "2027-02-02"],
    ] as const) {
      const side = run(ci, co);
      expect(side.kind).toBe("enabled");
      if (side.kind !== "enabled") continue;
      const q = new URLSearchParams(side.href.split("?")[1]);
      const night = q.get("night") ?? "";
      const returnDate = q.get("returnDate") ?? "";
      const checked = validateParkStayWindow({ night, arrivalTime: "7:00 PM", returnDate, returnTime: "6:00 PM", airportTimeZone: "America/New_York", now: NOW });
      expect(checked.ok, `${ci}→${co}`).toBe(true);
    }
  });

  it("a disabled side still names its airport and the parking page it came from", () => {
    expect(run("2026-10-21", "2026-10-25")).toEqual({
      kind: "disabled",
      reason: NEEDS_NIGHT_BEFORE,
      airport: "JFK",
      parkingHref: "/search?airport=JFK&checkin=2026-10-21&checkout=2026-10-25",
    });
  });

  it("hidden (no switch at all) unless the URL has an open airport and two usable dates", () => {
    const hidden: FromParking = { kind: "hidden" };
    expect(run(null, "2026-11-14")).toEqual(hidden);
    expect(run("2026-11-11", null)).toEqual(hidden);
    expect(run("", "")).toEqual(hidden);
    expect(run("2026-11-14", "2026-11-11")).toEqual(hidden); // reversed: the parking page shows its own error
    expect(run("2026-11-11", "2026-11-14", "BOS")).toEqual(hidden); // not a Park & Stay airport
    expect(run("2026-11-11", "2026-11-14", null)).toEqual(hidden);
  });

  it("never throws on bad input", () => {
    const junk = ["2026-02-30", "2026-13-01", "11/11/2026", "2026-1-1", "x", "   ", "2026-11-11T00:00", "null", "\u0000"];
    for (const a of junk) {
      for (const b of junk) {
        expect(() => run(a, b)).not.toThrow();
        expect(run(a, b)).toEqual({ kind: "hidden" });
      }
    }
    for (const airport of ["", "jf", "JFKX", "j f k", "<script>", "ÅÄÖ"]) expect(() => run("2026-11-11", "2026-11-14", airport)).not.toThrow();
    expect(() => run("2026-11-11", "2026-11-14", "JFK", new Date(Number.NaN))).not.toThrow();
    expect(run("2026-11-11", "2026-11-14", "JFK", new Date(Number.NaN))).toEqual({ kind: "hidden" });
  });

  it("takes the URL airport as typed (trimmed, any case)", () => {
    expect(openAirportFor(" jfk ", ACCESS)).toBe("JFK");
    expect(openAirportFor("lga", ACCESS)).toBeNull();
    expect(run("2026-11-11", "2026-11-14", "ewr")).toMatchObject({ kind: "enabled", airport: "EWR" });
  });
});

describe("lotBadgeHref — the badge only where the switch is enabled (R12-M7)", () => {
  const enabled = run("2026-11-11", "2026-11-14");

  it("a mapped hotel lot → the switch's link plus focus", () => {
    expect(lotBadgeHref(enabled, ACCESS.hotels, 132)).toBe("/park-stay?airport=JFK&night=2026-11-10&returnDate=2026-11-14&focus=doubletree-jfk");
  });

  it("an unmapped lot, a missing id, or a null id (staging) → none", () => {
    expect(lotBadgeHref(enabled, ACCESS.hotels, 7)).toBeNull();
    expect(lotBadgeHref(enabled, ACCESS.hotels, undefined)).toBeNull();
    expect(lotBadgeHref(enabled, ACCESS.hotels, null)).toBeNull();
  });

  it("another airport's hotel lot → none", () => {
    expect(lotBadgeHref(enabled, ACCESS.hotels, 320)).toBeNull();
  });

  it("same-day, out-of-window and hidden searches → none, whatever the lot", () => {
    for (const side of [run("2026-10-21", "2026-10-25"), run("2026-11-11", "2027-03-01"), run(null, null)]) {
      expect(side.kind).not.toBe("enabled");
      expect(lotBadgeHref(side, ACCESS.hotels, 132)).toBeNull();
    }
  });
});
