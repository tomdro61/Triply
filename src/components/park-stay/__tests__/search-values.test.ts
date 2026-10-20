import { describe, expect, it } from "vitest";
import { validateParkStayWindow } from "@/lib/hotels/parking-window";
import { formatNightLabel } from "../format";
import {
  DETAILS_PROMPT,
  RETURN_BEFORE_FLIGHT,
  initialHeaderFields,
  isPickerSwap,
  resolveFlight,
  sanitizeSearchValues,
  submitHref,
  type HeaderFields,
  apiSearchQuery,
  checkSearchDates,
  detailsPrompt,
  flightDateForNight,
  focusBanner,
  isCompleteSearch,
  missingDetails,
  nightChoices,
  nightForFlightDate,
  parkStayDateBounds,
  parkStayPageQuery,
  parkingOnlyHref,
  pickerMaxDate,
  readFocus,
  returnMaxForNight,
  type ParkStaySearchValues,
} from "../search-values";

const NY = "America/New_York";
const full: ParkStaySearchValues = { airport: "JFK", night: "2026-11-10", arrivalTime: "7:00 PM", returnDate: "2026-11-14", returnTime: "6:00 PM", adults: "2" };
const params = (o: Record<string, string>) => new URLSearchParams(o);

describe("night ↔ flight (calendar arithmetic, CX plan v2 §2)", () => {
  it("flight = night + 1 and night = flight − 1 across month end, year end and a leap day", () => {
    const pairs: Array<[string, string]> = [
      ["2026-10-31", "2026-11-01"],
      ["2026-11-30", "2026-12-01"],
      ["2026-12-31", "2027-01-01"],
      ["2028-02-28", "2028-02-29"],
      ["2028-02-29", "2028-03-01"],
      ["2027-02-28", "2027-03-01"],
    ];
    for (const [night, flight] of pairs) {
      expect(flightDateForNight(night), night).toBe(flight);
      expect(nightForFlightDate(flight), flight).toBe(night);
    }
  });

  it("the DST weekends do not shift a day (no ±86 400 000 ms)", () => {
    // US DST ends 1 Nov 2026 and starts 14 Mar 2027 (25- and 23-hour days).
    expect(flightDateForNight("2026-10-31")).toBe("2026-11-01");
    expect(flightDateForNight("2026-11-01")).toBe("2026-11-02");
    expect(nightForFlightDate("2027-03-14")).toBe("2027-03-13");
    expect(nightForFlightDate("2027-03-15")).toBe("2027-03-14");
  });

  it("a non-date is null, never guessed", () => {
    expect(flightDateForNight("")).toBeNull();
    expect(flightDateForNight("2026-02-30")).toBeNull();
    expect(nightForFlightDate("tomorrow")).toBeNull();
  });

  it("the night line names the night: 'Tue, Nov 10'", () => {
    expect(formatNightLabel("2026-11-10")).toBe("Tue, Nov 10");
    expect(formatNightLabel("2026-12-31")).toBe("Thu, Dec 31");
  });
});

describe("airport-local today and the flight minimum (review L-H1)", () => {
  it("late evening in New York is still 'today' there, though it is tomorrow in UTC", () => {
    const b = parkStayDateBounds(NY, new Date("2026-10-21T03:30:00Z")); // 11:30 PM EDT on Oct 20
    expect(b.today).toBe("2026-10-20");
    expect(b.flightMin).toBe("2026-10-21");
    expect(b.flightMax).toBe("2027-01-29"); // night ≤ today + 100 → flight ≤ today + 101
  });

  it("just after midnight in New York is the new day", () => {
    expect(parkStayDateBounds(NY, new Date("2026-10-21T04:05:00Z")).today).toBe("2026-10-21");
  });

  it("across the DST change (1 Nov 2026, 01:30 happens twice)", () => {
    const b = parkStayDateBounds(NY, new Date("2026-11-01T06:30:00Z")); // 01:30 EST, the second time
    expect(b.today).toBe("2026-11-01");
    expect(b.flightMin).toBe("2026-11-02");
  });

  it("at year end", () => {
    const b = parkStayDateBounds(NY, new Date("2027-01-01T03:00:00Z")); // 10 PM Dec 31 in New York
    expect(b.today).toBe("2026-12-31");
    expect(b.flightMin).toBe("2027-01-01");
  });

  it("a flight tomorrow gives a night of today, which the server accepts; a flight today would not be", () => {
    const now = new Date("2026-10-20T16:00:00Z");
    const b = parkStayDateBounds(NY, now);
    const night = nightForFlightDate(b.flightMin) ?? "";
    expect(night).toBe(b.today);
    const ok = validateParkStayWindow({ night, arrivalTime: "11:30 PM", returnDate: b.flightMin, returnTime: "6:00 PM", airportTimeZone: NY, now });
    expect(ok.ok).toBe(true);
    const past = validateParkStayWindow({ night: nightForFlightDate(b.today) ?? "", arrivalTime: "11:30 PM", returnDate: b.flightMin, returnTime: "6:00 PM", airportTimeZone: NY, now });
    expect(!past.ok && past.error.code).toBe("night_past");
  });
});

describe("the header's date rules", () => {
  const b = parkStayDateBounds(NY, new Date("2026-10-20T16:00:00Z"));
  const base = { airport: "JFK", flight: "2026-11-11", night: "2026-11-10", returnDate: "2026-11-14" };

  it("accepts a normal trip and a same-day return", () => {
    expect(checkSearchDates(base, b)).toBeNull();
    expect(checkSearchDates({ ...base, returnDate: base.flight }, b)).toBeNull();
  });

  it("names the field: airport, flight today, flight too far, return before flight (never swapped), > 60 days", () => {
    expect(checkSearchDates({ ...base, airport: "" }, b)?.field).toBe("airport");
    expect(checkSearchDates({ ...base, flight: b.today, night: "2026-10-19" }, b)?.field).toBe("flight");
    expect(checkSearchDates({ ...base, flight: "2027-01-30", night: "2027-01-29" }, b)?.field).toBe("flight");
    expect(checkSearchDates({ ...base, flight: "2027-01-29", night: "2027-01-28", returnDate: "2027-02-01" }, b)).toBeNull();
    expect(checkSearchDates({ ...base, returnDate: "2026-11-10" }, b)).toEqual({ field: "return", message: RETURN_BEFORE_FLIGHT });
    expect(checkSearchDates({ ...base, returnDate: "2027-01-09" }, b)).toBeNull(); // night + 60
    expect(checkSearchDates({ ...base, returnDate: "2027-01-10" }, b)?.message).toMatch(/60 days after the hotel night/);
    expect(checkSearchDates({ ...base, returnDate: "" }, b)?.field).toBe("return");
  });

  it("the night must be before the flight and not in the past", () => {
    expect(checkSearchDates({ ...base, night: base.flight }, b)?.field).toBe("night");
    expect(checkSearchDates({ ...base, night: "2026-11-09" }, b)).toBeNull(); // the red-eye choice
    expect(checkSearchDates({ ...base, flight: b.flightMin, night: "2026-10-19", returnDate: "2026-10-25" }, b)?.field).toBe("night");
  });

  it("return max is the night + 60 (plans.ts), not parking's 100", () => {
    expect(returnMaxForNight("2026-11-10")).toBe("2027-01-09");
  });

  it("night choices: the night before and the one before that, never before today", () => {
    expect(nightChoices("2026-11-11", b.today)).toEqual(["2026-11-10", "2026-11-09"]);
    expect(nightChoices(b.flightMin, b.today)).toEqual([b.today]);
    expect(nightChoices("", b.today)).toEqual([]);
  });

  it("the picker's one maxDate follows the leg being picked", () => {
    expect(pickerMaxDate({ flight: "", night: "", returnDate: "" }, b)).toBe(b.flightMax);
    expect(pickerMaxDate({ flight: "2026-11-11", night: "2026-11-10", returnDate: "" }, b)).toBe("2027-01-09");
    // both set: the later of the two limits (either leg may be reopened)
    expect(pickerMaxDate({ flight: "2026-11-11", night: "2026-11-10", returnDate: "2026-11-14" }, b)).toBe(b.flightMax);
    expect(pickerMaxDate({ flight: "2027-01-20", night: "2027-01-19", returnDate: "2027-01-25" }, b)).toBe("2027-03-20");
  });
});

describe("missing details: highlighted, never defaulted (plan §3)", () => {
  it("lists what is missing and the prompt", () => {
    expect(missingDetails({ arrivalTime: "", returnTime: "6:00 PM", adults: "" })).toEqual(["arrivalTime", "adults"]);
    expect(detailsPrompt(["arrivalTime", "adults"])).toBe(DETAILS_PROMPT);
    expect(DETAILS_PROMPT).toBe("Add when you'll reach the hotel and the number of guests to see prices.");
    expect(detailsPrompt(["returnTime"])).toBe("Add when you'll collect your car to see prices.");
    expect(detailsPrompt([])).toBeNull();
  });

  it("an incomplete search is not complete (the results stay idle: no fetch)", () => {
    expect(isCompleteSearch(full)).toBe(true);
    for (const k of Object.keys(full) as Array<keyof ParkStaySearchValues>) expect(isCompleteSearch({ ...full, [k]: "" }), k).toBe(false);
  });
});

describe("URLs", () => {
  it("every submit keeps flight and focus; empty keys are left out", () => {
    expect(parkStayPageQuery(full, { flight: "2026-11-11", focus: "doubletree-jfk" })).toBe(
      "airport=JFK&night=2026-11-10&arrivalTime=7%3A00+PM&returnDate=2026-11-14&returnTime=6%3A00+PM&adults=2&flight=2026-11-11&focus=doubletree-jfk"
    );
    expect(parkStayPageQuery({ ...full, arrivalTime: "", adults: "" }, { flight: null, focus: "doubletree-jfk" })).toBe(
      "airport=JFK&night=2026-11-10&returnDate=2026-11-14&returnTime=6%3A00+PM&focus=doubletree-jfk"
    );
    expect(parkStayPageQuery(full, { flight: null, focus: null })).not.toMatch(/focus|flight/);
    expect(parkStayPageQuery(full, { flight: "2026-02-30", focus: null })).not.toMatch(/flight/);
  });

  it("resolveFlight: the URL's flight when it is night + 1 or night + 2, otherwise night + 1", () => {
    expect(resolveFlight("2026-11-12", "2026-11-10")).toBe("2026-11-12");
    expect(resolveFlight("2026-11-11", "2026-11-10")).toBe("2026-11-11");
    expect(resolveFlight("2026-11-13", "2026-11-10")).toBe("2026-11-11");
    expect(resolveFlight("2026-11-10", "2026-11-10")).toBe("2026-11-11");
    expect(resolveFlight("junk", "2026-11-10")).toBe("2026-11-11");
    expect(resolveFlight(null, "2026-12-31")).toBe("2027-01-01");
    expect(resolveFlight("2026-11-12", "")).toBeNull();
  });

  it("the API query carries the six search keys only — never flight, focus or seen", () => {
    const q = new URLSearchParams(apiSearchQuery(full));
    expect([...q.keys()]).toEqual(["airport", "night", "arrivalTime", "returnDate", "returnTime", "adults"]);
  });

  it("readFocus accepts a hotel key and nothing else", () => {
    expect(readFocus(params({ focus: "doubletree-jfk" }))).toBe("doubletree-jfk");
    expect(readFocus(params({ focus: "<script>" }))).toBeNull();
    expect(readFocus(params({}))).toBeNull();
  });

  it("Parking only → /search?airport&checkin=<flight>&checkout=returnDate, nothing /search doesn't read", () => {
    expect(parkingOnlyHref(full, "2026-11-11")).toBe("/search?airport=JFK&checkin=2026-11-11&checkout=2026-11-14");
    // the red-eye night (2026-11-09, flight 2026-11-11): check-in is the FLIGHT date, not night + 1
    expect(parkingOnlyHref(sanitizeSearchValues({ ...full, night: "2026-11-09" }, ["JFK"]), resolveFlight("2026-11-11", "2026-11-09"))).toBe("/search?airport=JFK&checkin=2026-11-11&checkout=2026-11-14");
    expect(parkingOnlyHref({ airport: "jfk", returnDate: "2027-01-03" }, "2027-01-01")).toBe("/search?airport=JFK&checkin=2027-01-01&checkout=2027-01-03");
    // same-day return is a valid parking range
    expect(parkingOnlyHref({ ...full, returnDate: "2026-11-11" }, "2026-11-11")).toBe("/search?airport=JFK&checkin=2026-11-11&checkout=2026-11-11");
  });

  it("Parking only is disabled when the values can't make a parking search", () => {
    expect(parkingOnlyHref(full, null)).toBeNull();
    expect(parkingOnlyHref({ ...full, returnDate: "" }, "2026-11-11")).toBeNull();
    expect(parkingOnlyHref({ ...full, airport: "" }, "2026-11-11")).toBeNull();
    expect(parkingOnlyHref({ ...full, returnDate: "2026-11-10" }, "2026-11-11")).toBeNull(); // before the flight: no swap
  });
});

describe("sanitizeSearchValues: off-list values show as missing (review round 1, item 7)", () => {
  it("keeps on-list values (airport upper-cased) and blanks the rest, never picking an option", () => {
    expect(sanitizeSearchValues({ ...full, airport: "jfk" }, ["JFK", "LGA"])).toEqual(full);
    expect(
      sanitizeSearchValues({ airport: "BOS", night: "2026-02-30", arrivalTime: "3:15 PM", returnDate: "soon", returnTime: "25:00 PM", adults: "9" }, ["JFK"])
    ).toEqual({ airport: "", night: "", arrivalTime: "", returnDate: "", returnTime: "", adults: "" });
    expect(sanitizeSearchValues({ ...full, arrivalTime: "9:00 AM" }, ["JFK"]).arrivalTime).toBe(""); // a return slot, not an arrival slot
    expect(sanitizeSearchValues({ ...full, adults: "0" }, ["JFK"]).adults).toBe("");
  });

  it("a sanitised-away value makes the search incomplete (no fetch) and flags the field", () => {
    const v = sanitizeSearchValues({ ...full, arrivalTime: "3:15 PM" }, ["JFK"]);
    expect(isCompleteSearch(v)).toBe(false);
    expect(missingDetails(v)).toEqual(["arrivalTime"]);
  });
});

describe("the header: submit → URL → header round trip (review round 1, items 1 and 11)", () => {
  const b = parkStayDateBounds(NY, new Date("2026-10-20T16:00:00Z"));
  const fields: HeaderFields = { airport: "JFK", flight: "2026-11-11", night: "2026-11-09", returnDate: "2026-11-14", arrivalTime: "7:00 PM", returnTime: "6:00 PM", adults: "2" };

  function reload(href: string): HeaderFields {
    const p = new URL(href, "https://x.test").searchParams;
    const values = sanitizeSearchValues(
      {
        airport: p.get("airport") ?? "",
        night: p.get("night") ?? "",
        arrivalTime: p.get("arrivalTime") ?? "",
        returnDate: p.get("returnDate") ?? "",
        returnTime: p.get("returnTime") ?? "",
        adults: p.get("adults") ?? "",
      },
      ["JFK"]
    );
    return initialHeaderFields(values, p.get("flight"));
  }

  it("a changed night keeps the flight date through the round trip", () => {
    const out = submitHref(fields, b, "doubletree-jfk");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.href).toBe(
      "/park-stay?airport=JFK&night=2026-11-09&arrivalTime=7%3A00+PM&returnDate=2026-11-14&returnTime=6%3A00+PM&adults=2&flight=2026-11-11&focus=doubletree-jfk"
    );
    expect(reload(out.href)).toEqual(fields);
    // the night choices stay relative to the flight
    expect(nightChoices(reload(out.href).flight, b.today)).toEqual(["2026-11-10", "2026-11-09"]);
  });

  it("the default night round-trips too, and missing details still navigate (flagged on reload)", () => {
    const def = { ...fields, night: "2026-11-10", arrivalTime: "", adults: "" };
    const out = submitHref(def, b, null);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.href).not.toMatch(/arrivalTime|adults|focus/);
    const back = reload(out.href);
    expect(back).toEqual(def);
    expect(missingDetails(back)).toEqual(["arrivalTime", "adults"]);
  });

  it("a date problem blocks the submit and names it", () => {
    expect(submitHref({ ...fields, returnDate: "2026-11-10" }, b, null)).toEqual({ ok: false, problem: { field: "return", message: RETURN_BEFORE_FLIGHT } });
    expect(submitHref({ ...fields, night: "2026-11-08" }, b, null)).toMatchObject({ ok: false, problem: { field: "night" } });
  });
});

describe("the picker's swap is rejected, never applied (review round 1, item 2)", () => {
  it("start earlier than the flight followed at once by end = the old flight → a swap", () => {
    expect(isPickerSwap({ start: "2026-11-08", prevFlight: "2026-11-11" }, "2026-11-11")).toBe(true);
  });

  it("a first click (end cleared), a normal return pick, or a later start is not a swap", () => {
    expect(isPickerSwap({ start: "2026-11-08", prevFlight: "2026-11-11" }, "")).toBe(false);
    expect(isPickerSwap(null, "2026-11-14")).toBe(false);
    expect(isPickerSwap({ start: "2026-11-12", prevFlight: "2026-11-11" }, "2026-11-11")).toBe(false);
    expect(isPickerSwap({ start: "2026-11-08", prevFlight: "" }, "2026-11-11")).toBe(false);
  });
});

describe("the focus banner (review L-H4: never a silent swap)", () => {
  const hotels = [
    { key: "doubletree-jfk", airport: "JFK", name: "DoubleTree by Hilton New York JFK Airport" },
    { key: "laguardia-marriott", airport: "LGA", name: "New York LaGuardia Airport Marriott" },
  ];

  it("no focus, or the focus hotel is shown → no banner", () => {
    expect(focusBanner({ focus: null, airport: "JFK", offerKeys: ["hampton-inn-jfk"], partial: false, hotels })).toBeNull();
    expect(focusBanner({ focus: "doubletree-jfk", airport: "JFK", offerKeys: ["doubletree-jfk"], partial: false, hotels })).toBeNull();
  });

  it("missing from a complete answer → names the hotel from the map", () => {
    expect(focusBanner({ focus: "doubletree-jfk", airport: "JFK", offerKeys: ["hampton-inn-jfk"], partial: false, hotels })).toBe(
      "DoubleTree by Hilton New York JFK Airport has no rooms we can offer for these dates. Here are the other hotels."
    );
    expect(focusBanner({ focus: "doubletree-jfk", airport: "JFK", offerKeys: [], partial: false, hotels })).toBe(
      "DoubleTree by Hilton New York JFK Airport has no rooms we can offer for these dates."
    );
  });

  it("a partial answer says we couldn't check it, not that it has no rooms", () => {
    expect(focusBanner({ focus: "doubletree-jfk", airport: "JFK", offerKeys: ["hampton-inn-jfk"], partial: true, hotels })).toBe(
      "We couldn't check DoubleTree by Hilton New York JFK Airport right now. Here are the other hotels."
    );
  });

  it("an unknown key still gets a banner; another airport's hotel (focus kept after an airport change) gets none", () => {
    expect(focusBanner({ focus: "gone-hotel", airport: "JFK", offerKeys: ["hampton-inn-jfk"], partial: false, hotels })).toMatch(/^That hotel has no rooms/);
    expect(focusBanner({ focus: "laguardia-marriott", airport: "JFK", offerKeys: ["hampton-inn-jfk"], partial: false, hotels })).toBeNull();
  });
});
