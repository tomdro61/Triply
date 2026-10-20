import { describe, expect, it } from "vitest";
import { validateParkStayWindow } from "@/lib/hotels/parking-window";
import { formatNightLabel } from "../format";
import { readSearchValues } from "../search-results";
import {
  DETAILS_PROMPT,
  RETURN_BEFORE_CHECKIN,
  RETURN_BEFORE_CHECKOUT,
  apiSearchQuery,
  checkSearchDates,
  checkoutDateFor,
  detailsPrompt,
  focusBanner,
  isCompleteSearch,
  isPickerSwap,
  missingDetails,
  parkStayDateBounds,
  parkStayPageQuery,
  parkingOnlyHref,
  pickerMaxDate,
  readFocus,
  returnMaxForNight,
  sanitizeSearchValues,
  submitHref,
  type HeaderFields,
  type ParkStaySearchValues,
} from "../search-values";

const NY = "America/New_York";
const full: ParkStaySearchValues = { airport: "JFK", night: "2026-11-10", arrivalTime: "7:00 PM", returnDate: "2026-11-14", returnTime: "6:00 PM", adults: "2" };
const params = (o: Record<string, string>) => new URLSearchParams(o);

const TODAY = "2026-10-21"; // today+100 = 2027-01-29

describe("check-in → check-out (calendar arithmetic)", () => {
  it("check-out = check-in + 1 across month end, year end, a leap day and the DST weekends", () => {
    const pairs: Array<[string, string]> = [
      ["2026-10-31", "2026-11-01"],
      ["2026-11-01", "2026-11-02"], // DST ends (a 25-hour day)
      ["2027-03-14", "2027-03-15"], // DST starts (a 23-hour day)
      ["2026-12-31", "2027-01-01"],
      ["2028-02-28", "2028-02-29"],
      ["2027-02-28", "2027-03-01"],
    ];
    for (const [night, checkout] of pairs) expect(checkoutDateFor(night), night).toBe(checkout);
    expect(checkoutDateFor("2026-02-30")).toBeNull();
  });

  it("the trigger labels: 'Tue, Nov 10'", () => {
    expect(formatNightLabel("2026-11-10")).toBe("Tue, Nov 10");
    expect(formatNightLabel("2026-12-31")).toBe("Thu, Dec 31");
  });
});

describe("airport-local today is the earliest check-in", () => {
  it("late evening in New York is still 'today' there, though it is tomorrow in UTC", () => {
    const b = parkStayDateBounds(NY, new Date("2026-10-21T03:30:00Z")); // 11:30 PM EDT on Oct 20
    expect(b.today).toBe("2026-10-20");
    expect(b.checkinMax).toBe("2027-01-28"); // today + 100
  });

  it("just after midnight in New York is the new day; DST night and year end too", () => {
    expect(parkStayDateBounds(NY, new Date("2026-10-21T04:05:00Z")).today).toBe("2026-10-21");
    expect(parkStayDateBounds(NY, new Date("2026-11-01T06:30:00Z")).today).toBe("2026-11-01"); // 01:30 EST, the second time
    expect(parkStayDateBounds(NY, new Date("2027-01-01T03:00:00Z")).today).toBe("2026-12-31"); // 10 PM Dec 31 in New York
  });

  it("check-in today is allowed, by the header and by the server; yesterday is rejected by both", () => {
    const now = new Date("2026-10-21T02:00:00Z"); // 10 PM Oct 20 in New York, already Oct 21 in UTC
    const b = parkStayDateBounds(NY, now);
    const today = { airport: "JFK", night: "2026-10-20", returnDate: "2026-10-23" };
    expect(checkSearchDates(today, b)).toBeNull();
    expect(validateParkStayWindow({ night: today.night, arrivalTime: "11:30 PM", returnDate: today.returnDate, returnTime: "6:00 PM", airportTimeZone: NY, now }).ok).toBe(true);

    const yesterday = { ...today, night: "2026-10-19" };
    expect(checkSearchDates(yesterday, b)).toEqual({ field: "night", message: "The hotel check-in date can't be in the past." });
    const server = validateParkStayWindow({ night: yesterday.night, arrivalTime: "11:30 PM", returnDate: today.returnDate, returnTime: "6:00 PM", airportTimeZone: NY, now });
    expect(!server.ok && server.error.code).toBe("night_past");
  });
});

describe("the header's date rules match validateParkStayWindow", () => {
  const now = new Date("2026-10-20T16:00:00Z");
  const b = parkStayDateBounds(NY, now);
  const base = { airport: "JFK", night: "2026-11-10", returnDate: "2026-11-14" };
  const server = (night: string, returnDate: string) =>
    validateParkStayWindow({ night, arrivalTime: "7:00 PM", returnDate, returnTime: "6:00 PM", airportTimeZone: NY, now }).ok;

  it("accepts a normal trip and a return on the check-out day", () => {
    expect(checkSearchDates(base, b)).toBeNull();
    expect(checkSearchDates({ ...base, returnDate: "2026-11-11" }, b)).toBeNull();
    expect(server("2026-11-10", "2026-11-11")).toBe(true);
  });

  it("a return before the check-in is an error (never a swap); a same-day return is before check-out, as on the server", () => {
    expect(checkSearchDates({ ...base, returnDate: "2026-11-09" }, b)).toEqual({ field: "return", message: RETURN_BEFORE_CHECKIN });
    expect(RETURN_BEFORE_CHECKIN).toBe("Parking return date must be on or after your hotel check-in date.");
    expect(checkSearchDates({ ...base, returnDate: "2026-11-10" }, b)).toEqual({ field: "return", message: RETURN_BEFORE_CHECKOUT });
    expect(server("2026-11-10", "2026-11-10")).toBe(false);
  });

  it("names the other problems: airport, too far ahead, > 60 days, missing return", () => {
    expect(checkSearchDates({ ...base, airport: "" }, b)?.field).toBe("airport");
    expect(checkSearchDates({ ...base, night: "2027-01-28", returnDate: "2027-02-01" }, b)).toBeNull(); // today + 100
    expect(checkSearchDates({ ...base, night: "2027-01-29", returnDate: "2027-02-01" }, b)?.field).toBe("night");
    expect(server("2027-01-29", "2027-02-01")).toBe(false);
    expect(checkSearchDates({ ...base, returnDate: "2027-01-09" }, b)).toBeNull(); // night + 60
    expect(checkSearchDates({ ...base, returnDate: "2027-01-10" }, b)?.message).toMatch(/60 days after the hotel check-in/);
    expect(server("2026-11-10", "2027-01-10")).toBe(false);
    expect(checkSearchDates({ ...base, returnDate: "" }, b)?.field).toBe("return");
  });

  it("return max is the check-in + 60 (plans.ts), not parking's 100", () => {
    expect(returnMaxForNight("2026-11-10")).toBe("2027-01-09");
  });

  it("the picker's one maxDate follows the leg being picked", () => {
    expect(pickerMaxDate({ night: "", returnDate: "" }, b)).toBe(b.checkinMax);
    // Reopening the check-in leg must never block a valid check-in (review recheck M1).
    expect(pickerMaxDate({ night: "2026-11-10", returnDate: "" }, b)).toBe(b.checkinMax > "2027-01-09" ? b.checkinMax : "2027-01-09");
    expect(pickerMaxDate({ night: "2026-11-10", returnDate: "2026-11-14" }, b)).toBe(b.checkinMax);
    expect(pickerMaxDate({ night: "2027-01-19", returnDate: "2027-01-25" }, b)).toBe("2027-03-20");
  });
});

describe("the picker's swap is rejected, never applied", () => {
  it("start earlier than the check-in followed at once by end = the old check-in → a swap", () => {
    expect(isPickerSwap({ start: "2026-11-08", prevStart: "2026-11-10" }, "2026-11-10")).toBe(true);
  });

  it("a first click (end cleared), a normal return pick, or a later start is not a swap", () => {
    expect(isPickerSwap({ start: "2026-11-08", prevStart: "2026-11-10" }, "")).toBe(false);
    expect(isPickerSwap(null, "2026-11-14")).toBe(false);
    expect(isPickerSwap({ start: "2026-11-12", prevStart: "2026-11-10" }, "2026-11-10")).toBe(false);
    expect(isPickerSwap({ start: "2026-11-08", prevStart: "" }, "2026-11-10")).toBe(false);
  });
});

describe("missing details: highlighted, never defaulted (plan §3)", () => {
  it("lists what is missing; the prompt names the return time only while it is missing", () => {
    expect(missingDetails({ arrivalTime: "", returnTime: "6:00 PM", adults: "" })).toEqual(["arrivalTime", "adults"]);
    expect(detailsPrompt(["arrivalTime", "returnTime", "adults"])).toBe(DETAILS_PROMPT);
    expect(DETAILS_PROMPT).toBe("Add when you'll reach the hotel, your return time and the number of guests to see prices.");
    expect(detailsPrompt(["arrivalTime", "adults"])).toBe("Add when you'll reach the hotel and the number of guests to see prices.");
    expect(detailsPrompt(["returnTime"])).toBe(DETAILS_PROMPT);
    expect(detailsPrompt([])).toBeNull();
  });

  it("an incomplete search is not complete (the results stay idle: no fetch)", () => {
    expect(isCompleteSearch(full)).toBe(true);
    for (const k of Object.keys(full) as Array<keyof ParkStaySearchValues>) expect(isCompleteSearch({ ...full, [k]: "" }), k).toBe(false);
  });
});

describe("URLs", () => {
  it("every submit keeps focus; empty keys are left out", () => {
    expect(parkStayPageQuery(full, "doubletree-jfk")).toBe(
      "airport=JFK&night=2026-11-10&arrivalTime=7%3A00+PM&returnDate=2026-11-14&returnTime=6%3A00+PM&adults=2&focus=doubletree-jfk"
    );
    expect(parkStayPageQuery({ ...full, arrivalTime: "", adults: "" }, "doubletree-jfk")).toBe(
      "airport=JFK&night=2026-11-10&returnDate=2026-11-14&returnTime=6%3A00+PM&focus=doubletree-jfk"
    );
    expect(parkStayPageQuery(full, null)).not.toMatch(/focus/);
  });

  it("the API query carries the six search keys only — never focus or seen", () => {
    const q = new URLSearchParams(apiSearchQuery(full));
    expect([...q.keys()]).toEqual(["airport", "night", "arrivalTime", "returnDate", "returnTime", "adults"]);
  });

  it("readFocus accepts a hotel key and nothing else", () => {
    expect(readFocus(params({ focus: "doubletree-jfk" }))).toBe("doubletree-jfk");
    expect(readFocus(params({ focus: "<script>" }))).toBeNull();
    expect(readFocus(params({}))).toBeNull();
  });

  it("an old link's stray `flight` param is ignored: same values, same API query, dropped on the next submit", () => {
    const withFlight = params({ ...full, flight: "2026-11-12", focus: "doubletree-jfk" });
    const values = sanitizeSearchValues(readSearchValues(withFlight), ["JFK"]);
    expect(values).toEqual(full);
    expect(apiSearchQuery(values)).toBe(apiSearchQuery(full));
    const out = submitHref(values, parkStayDateBounds(NY, new Date("2026-10-20T16:00:00Z")), readFocus(withFlight));
    expect(out.ok && out.href).toBe(`/park-stay?${parkStayPageQuery(full, "doubletree-jfk")}`);
    expect(out.ok && out.href).not.toMatch(/flight/);
  });

  it("Parking only → /search?airport&checkin=<check-in + 1>&checkout=returnDate, nothing /search doesn't read", () => {
    expect(parkingOnlyHref(full, TODAY)).toBe("/search?airport=JFK&checkin=2026-11-11&checkout=2026-11-14");
    expect(parkingOnlyHref({ airport: "jfk", night: "2026-12-31", returnDate: "2027-01-03" }, TODAY)).toBe("/search?airport=JFK&checkin=2027-01-01&checkout=2027-01-03");
    // a return on the hotel check-out day is a valid same-day parking range
    expect(parkingOnlyHref({ ...full, returnDate: "2026-11-11" }, TODAY)).toBe("/search?airport=JFK&checkin=2026-11-11&checkout=2026-11-11");
  });

  it("Parking only is disabled when the values can't make a parking search (never swapped)", () => {
    expect(parkingOnlyHref({ ...full, night: "" }, TODAY)).toBeNull();
    expect(parkingOnlyHref({ ...full, returnDate: "" }, TODAY)).toBeNull();
    expect(parkingOnlyHref({ ...full, airport: "" }, TODAY)).toBeNull();
    expect(parkingOnlyHref({ ...full, returnDate: "2026-11-10" }, TODAY)).toBeNull();
    // ResLab takes a check-in up to 100 days ahead: a hotel night on day 100 can't link to parking (review recheck L3).
    expect(parkingOnlyHref({ airport: "JFK", night: "2027-01-28", returnDate: "2027-02-02" }, TODAY)).toBe("/search?airport=JFK&checkin=2027-01-29&checkout=2027-02-02");
    expect(parkingOnlyHref({ airport: "JFK", night: "2027-01-29", returnDate: "2027-02-02" }, TODAY)).toBeNull();
    expect(parkingOnlyHref(full, "")).toBeNull();
  });
});

describe("sanitizeSearchValues: off-list values show as missing", () => {
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

describe("the header submit", () => {
  const b = parkStayDateBounds(NY, new Date("2026-10-20T16:00:00Z"));
  const fields: HeaderFields = full;

  it("goes to /park-stay with the search and focus, and the URL reads back to the same fields", () => {
    const out = submitHref(fields, b, "doubletree-jfk");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.href).toBe(
      "/park-stay?airport=JFK&night=2026-11-10&arrivalTime=7%3A00+PM&returnDate=2026-11-14&returnTime=6%3A00+PM&adults=2&focus=doubletree-jfk"
    );
    const back = new URL(out.href, "https://x.test").searchParams;
    expect(sanitizeSearchValues(readSearchValues(back), ["JFK"])).toEqual(fields);
    expect(readFocus(back)).toBe("doubletree-jfk");
  });

  it("missing details still navigate and are flagged on the way back", () => {
    const out = submitHref({ ...fields, arrivalTime: "", adults: "" }, b, null);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.href).not.toMatch(/arrivalTime|adults|focus/);
    expect(missingDetails(readSearchValues(new URL(out.href, "https://x.test").searchParams))).toEqual(["arrivalTime", "adults"]);
  });

  it("a date problem blocks the submit and names it", () => {
    expect(submitHref({ ...fields, returnDate: "2026-11-09" }, b, null)).toEqual({ ok: false, problem: { field: "return", message: RETURN_BEFORE_CHECKIN } });
    expect(submitHref({ ...fields, night: "2026-10-19" }, b, null)).toMatchObject({ ok: false, problem: { field: "night" } });
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
