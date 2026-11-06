import { describe, it, expect } from "vitest";
import {
  amenitiesBesideShuttle,
  formatMinutes,
  outsideShuttleHours,
  shuttleHoursText,
  shuttleIsWarning,
  shuttleLabel,
  shuttleStatus,
  shuttleTimeWarning,
} from "../shuttle-status";

// Every string below is a real ResLab shuttleInfo.summary from the live search
// snapshot of 2026-11-06 (246 lots, 70 airports).

describe("shuttleStatus — no shuttle", () => {
  it.each([
    "No Shuttle. Uber and Lyft are readily available, affordable, and will bring you directly to and from airport without the wait.",
    "NO SHUTTLE",
    "no shuttle",
    "No shuttle, guests must arrange their own airport transportation",
    "NO shuttle, but it's an easy walk to the airport",
    "No shuttle; minutes from the airport via quick rideshare/taxi.",
  ])("%s → none", (s) => {
    expect(shuttleStatus(s)).toEqual({ kind: "none" });
  });

  it.each([
    "Shuttle suspended",
    "Shuttle temporarily suspended. You may arrange for your own Uber/Lyft",
    "Shuttle service is currently suspended; however, the airport is just a short and convenient Uber or Lyft ride away, making transfers quick and easy.",
  ])("%s → suspended", (s) => {
    expect(shuttleStatus(s)).toEqual({ kind: "suspended" });
  });
});

describe("shuttleStatus — 24/7", () => {
  it.each([
    "24/7, every 15 minutes",
    "24/7 on demand",
    "24 hours on demand to and from the airport.",
    "Shuttle runs 24/7 every 10-15 minutes",
    "Shuttles run 24 hours a day, departing every 10 to 15 minutes. Return pickups are available on demand.",
    "12:00 AM - 12:00 AM: Shuttle runs every 20 minutes.",
    // Structured, two running windows and no gap.
    "4:00 AM - 12:00 AM: Shuttle runs every 15 minutes.  12:00 AM - 4:00 AM: Shuttle runs every 30 minutes.",
    "6:00 AM - 11:00 PM: Shuttle runs every 30 minutes.  11:00 PM - 6:00 AM: Shuttle runs on demand.",
  ])("%s → all_day", (s) => {
    expect(shuttleStatus(s)).toEqual({ kind: "all_day" });
  });

  it.each(["24/7 complimentary Lyft", "24/7 Valet Service - Will drop you off at your Terminal in your own vehicle"])(
    "%s → unknown (not a shuttle)",
    (s) => {
      expect(shuttleStatus(s)).toEqual({ kind: "unknown" });
    }
  );
});

describe("shuttleStatus — hours", () => {
  it("ATL Routes: one window, with the 11:30 PM – 6 AM gap", () => {
    const s = shuttleStatus("6:00 AM - 11:30 PM: Shuttle runs on demand.  11:30 PM - 6:00 AM: No shuttle.");
    expect(s).toEqual({ kind: "hours", windows: [{ start: 360, end: 1410 }] });
    expect(shuttleLabel(s)).toBe("Shuttle 6 AM–11:30 PM");
  });

  it("a window ending at 12:00 AM ends at midnight, not the start of the day", () => {
    const s = shuttleStatus("5:00 AM - 12:00 AM: Shuttle runs every 30 minutes.  12:00 AM - 5:00 AM: No shuttle.");
    expect(s).toEqual({ kind: "hours", windows: [{ start: 300, end: 1440 }] });
    expect(shuttleLabel(s)).toBe("Shuttle 5 AM–midnight");
  });

  it("a window that wraps past midnight", () => {
    const s = shuttleStatus("3:30 AM - 1:30 AM: Shuttle runs every 30 minutes.  1:30 AM - 3:30 AM: No shuttle.");
    expect(s).toEqual({ kind: "hours", windows: [{ start: 210, end: 90 }] });
  });

  it("midday gap keeps both windows", () => {
    const s = shuttleStatus(
      "4:00 AM - 10:00 AM: Shuttle runs every 30 minutes.  10:00 AM - 5:00 PM: No shuttle.  5:00 PM - 11:00 PM: Shuttle runs every 30 minutes.  11:00 PM - 4:00 AM: No shuttle."
    );
    expect(s).toEqual({ kind: "hours", windows: [{ start: 240, end: 600 }, { start: 1020, end: 1380 }] });
    expect(shuttleLabel(s)).toBe("Shuttle: limited hours");
    expect(shuttleHoursText(s)).toBe("Shuttle runs 4 AM–10 AM and 5 PM–11 PM");
  });

  it("back-to-back running windows merge into one (MCI)", () => {
    const s = shuttleStatus(
      "4:00 AM - 7:30 AM: Shuttle runs every 30 minutes.  7:30 AM - 11:00 PM: Shuttle runs on demand.  11:00 PM - 4:00 AM: No shuttle."
    );
    expect(s).toEqual({ kind: "hours", windows: [{ start: 240, end: 1380 }] });
    expect(shuttleLabel(s)).toBe("Shuttle 4 AM–11 PM");
  });

  it("three running windows that end past midnight merge (DEN)", () => {
    const s = shuttleStatus(
      "3:30 AM - 12:00 PM: Shuttle runs every 30 minutes.  12:00 PM - 5:00 PM: Shuttle runs every 1 hour.  5:00 PM - 1:30 AM: Shuttle runs every 30 minutes.  1:30 AM - 3:30 AM: No shuttle."
    );
    expect(s).toEqual({ kind: "hours", windows: [{ start: 210, end: 90 }] });
    expect(shuttleLabel(s)).toBe("Shuttle 3:30 AM–1:30 AM");
  });

  it.each([
    ["5 AM - 10 PM, every 30 minutes", 300, 1320],
    ["Shuttle runs 4 AM to 11 PM", 240, 1380],
    ["4 AM - Midnight On Demand", 240, 1440],
    ["Shuttle runs from 4:30 AM to 10 PM every 30 minutes within shuttle hours.", 270, 1320],
    ["7am to 10pm once an hour top of the hour", 420, 1320],
    ["4AM - 12PM, every 30 minutes, except at 7AM, 3PM, and 11PM", 240, 1440],
  ])("free-form %s", (s, start, end) => {
    expect(shuttleStatus(s)).toEqual({ kind: "hours", windows: [{ start, end }] });
  });

  it("weekday-dependent hours → limited hours, no windows (never warns)", () => {
    const s = shuttleStatus(
      "Sun-Thu4:30 AM - 11:30 PM: Shuttle runs every 1 hour.  11:30 PM - 4:30 AM: No shuttle.  Fri-Sat4:30 AM - 12:45 AM: Shuttle runs every 1 hour."
    );
    expect(s).toEqual({ kind: "hours", windows: null });
    expect(shuttleLabel(s)).toBe("Shuttle: limited hours");
    expect(outsideShuttleHours(s, "3:00 AM")).toBe(false);
  });
});

describe("shuttleStatus — unknown (say nothing)", () => {
  it.each([
    "",
    "Every 30 minutes to and from the airport",
    "Shuttle to the terminal (about 10 min)",
    "Airtrain directly to airport",
    "Shuttle for Check-in starts 4 AM. Shuttle for Check-out is 24/7.",
    "Disembarkation: 7:30 AM to 10:45 AM, every 30 minutesEmbarkation: 11 AM to 3:15 PM, every 30 minutes",
    "24/7 From the Parking Lot to the Airport:* Shuttle runs Every 10 - 15 minutes 24/7/365 days. From the Airport to the Parking Lot:* (4:00 AM - 12:00 AM) Shuttle",
    "8 AM - 3:45 AM every 30 minutes and on call 3:45 AM - 8 AM on demand",
  ])("%s → unknown", (s) => {
    expect(shuttleStatus(s).kind).toBe("unknown");
  });

  it("null and undefined", () => {
    expect(shuttleStatus(null).kind).toBe("unknown");
    expect(shuttleStatus(undefined).kind).toBe("unknown");
    expect(shuttleLabel({ kind: "unknown" })).toBeNull();
  });
});

describe("outsideShuttleHours", () => {
  const routes = shuttleStatus("6:00 AM - 11:30 PM: Shuttle runs on demand.  11:30 PM - 6:00 AM: No shuttle.");
  const wrap = shuttleStatus("3:30 AM - 1:30 AM: Shuttle runs every 30 minutes.  1:30 AM - 3:30 AM: No shuttle.");

  it("the live repro: 4:00 AM drop-off and 1:00 AM return at Routes ATL both miss", () => {
    expect(outsideShuttleHours(routes, "4:00 AM")).toBe(true);
    expect(outsideShuttleHours(routes, "1:00 AM")).toBe(true);
  });

  it("window edges are inside", () => {
    expect(outsideShuttleHours(routes, "6:00 AM")).toBe(false);
    expect(outsideShuttleHours(routes, "11:30 PM")).toBe(false);
    expect(outsideShuttleHours(routes, "12:00 PM")).toBe(false);
  });

  it("wrapping windows", () => {
    expect(outsideShuttleHours(wrap, "1:00 AM")).toBe(false);
    expect(outsideShuttleHours(wrap, "2:00 AM")).toBe(true);
    expect(outsideShuttleHours(wrap, "11:30 PM")).toBe(false);
  });

  it("never warns for 24/7, none, unknown, or an unreadable time", () => {
    expect(outsideShuttleHours({ kind: "all_day" }, "3:00 AM")).toBe(false);
    expect(outsideShuttleHours({ kind: "none" }, "3:00 AM")).toBe(false);
    expect(outsideShuttleHours({ kind: "unknown" }, "3:00 AM")).toBe(false);
    expect(outsideShuttleHours(routes, "")).toBe(false);
    expect(outsideShuttleHours(routes, "late")).toBe(false);
  });
});

describe("shuttleTimeWarning", () => {
  const routes = shuttleStatus("6:00 AM - 11:30 PM: Shuttle runs on demand.  11:30 PM - 6:00 AM: No shuttle.");

  it("both times outside (the live repro)", () => {
    expect(shuttleTimeWarning(routes, "4:00 AM", "1:00 AM")).toBe(
      "Your 4:00 AM drop-off and 1:00 AM return are outside shuttle hours (6 AM–11:30 PM). Check with the lot before booking."
    );
  });

  it("one time outside", () => {
    expect(shuttleTimeWarning(routes, "4:00 AM", "2:00 PM")).toBe(
      "Your 4:00 AM drop-off is outside shuttle hours (6 AM–11:30 PM). Check with the lot before booking."
    );
    expect(shuttleTimeWarning(routes, "10:00 AM", "11:59 PM")).toBe(
      "Your 11:59 PM return is outside shuttle hours (6 AM–11:30 PM). Check with the lot before booking."
    );
  });

  it("no warning inside hours, without times, or when the hours are unknown", () => {
    expect(shuttleTimeWarning(routes, "10:00 AM", "2:00 PM")).toBeNull();
    expect(shuttleTimeWarning(routes, "", "")).toBeNull();
    expect(shuttleTimeWarning({ kind: "all_day" }, "3:00 AM", "1:00 AM")).toBeNull();
    expect(shuttleTimeWarning({ kind: "none" }, "3:00 AM", "1:00 AM")).toBeNull();
  });
});

describe("labels", () => {
  it("chip text per kind", () => {
    expect(shuttleLabel({ kind: "none" })).toBe("No shuttle");
    expect(shuttleLabel({ kind: "suspended" })).toBe("Shuttle suspended");
    expect(shuttleLabel({ kind: "all_day" })).toBe("24/7 shuttle");
  });

  it("warning kinds", () => {
    expect(shuttleIsWarning({ kind: "none" })).toBe(true);
    expect(shuttleIsWarning({ kind: "suspended" })).toBe(true);
    expect(shuttleIsWarning({ kind: "all_day" })).toBe(false);
  });

  it("formatMinutes", () => {
    expect(formatMinutes(0)).toBe("midnight");
    expect(formatMinutes(1440)).toBe("midnight");
    expect(formatMinutes(720)).toBe("noon");
    expect(formatMinutes(270)).toBe("4:30 AM");
    expect(formatMinutes(1410)).toBe("11:30 PM");
  });
});

describe("amenitiesBesideShuttle", () => {
  const amenities = [{ displayName: "Free Shuttle" }, { displayName: "24/7 Front Desk" }];

  it("drops a shuttle amenity when the chip states the shuttle (no contradiction)", () => {
    expect(amenitiesBesideShuttle(amenities, "No shuttle")).toEqual([{ displayName: "24/7 Front Desk" }]);
    expect(amenitiesBesideShuttle(amenities, "24/7 every 15 minutes")).toEqual([{ displayName: "24/7 Front Desk" }]);
  });

  it("keeps it when the summary can't be read (no chip shows)", () => {
    expect(amenitiesBesideShuttle(amenities, "Shuttle to the terminal (about 10 min)")).toEqual(amenities);
    expect(amenitiesBesideShuttle(amenities, undefined)).toEqual(amenities);
  });
});
