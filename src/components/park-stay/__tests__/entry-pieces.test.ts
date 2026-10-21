import { describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: (props: { href: string; className?: string; children?: ReactNode; "aria-current"?: string; onClick?: unknown }) =>
    createElement("a", { href: props.href, className: props.className, "aria-current": props["aria-current"] }, props.children),
}));
vi.mock("next/image", () => ({ default: (props: { src: string; alt: string }) => createElement("img", { src: props.src, alt: props.alt }) }));

import type { ParkStayAccess } from "@/lib/hotels/access";
import { accessAirportOptions, heroDateLimits, heroSubmit } from "../entry/hero-dates";
import { HOME_CARD_LIMIT, homeCards } from "../entry/home-cards";
import { ParkStayLotBadge } from "../entry/parking-lot-badge";
import { ParkStayHomeSection } from "../entry/home-section";
import { RETURN_BEFORE_CHECKIN } from "../search-values";

const ACCESS: ParkStayAccess = {
  airports: [
    { code: "JFK", name: "JFK Airport" },
    { code: "LGA", name: "LaGuardia Airport" },
    { code: "EWR", name: "Newark Liberty International Airport" },
  ],
  hotels: [
    { key: "doubletree-jfk", airport: "JFK", reslabLotId: 132, name: "DoubleTree JFK", photoUrl: "https://static.cupid.travel/hotels/1.jpg", shuttle: "Shuttle every 30 min, 24/7" },
    { key: "hampton-inn-jfk", airport: "JFK", reslabLotId: 304, name: "Hampton Inn JFK", photoUrl: null, shuttle: "Shuttle 24/7" },
    { key: "hyatt-place-flushing-lga", airport: "LGA", reslabLotId: 159, name: "Hyatt Place", photoUrl: null, shuttle: "Shuttle 7 AM – 10 PM" },
    { key: "renaissance-newark-airport", airport: "EWR", reslabLotId: 259, name: "Renaissance Newark", photoUrl: null, shuttle: "Shuttle every 15 min, 4 AM – 12 AM" },
    { key: "courtyard-newark-liberty", airport: "EWR", reslabLotId: 378, name: "Courtyard Newark", photoUrl: null, shuttle: "Shuttle every 30 min, 24/7" },
  ],
};

/** 21 Oct 2026, 3 PM in New York. */
const NOW = new Date("2026-10-21T19:00:00Z");

describe("the hero tab's date limits (CX plan §2, §11, §12.3)", () => {
  const airports = accessAirportOptions(ACCESS);

  it("the access airports carry their time zone from the airport config; an unknown code is dropped", () => {
    expect(airports.map((a) => [a.code, a.timezone])).toEqual([
      ["JFK", "America/New_York"],
      ["LGA", "America/New_York"],
      ["EWR", "America/New_York"],
    ]);
    expect(accessAirportOptions({ airports: [{ code: "ZZZ", name: "Nowhere" }] })).toEqual([]);
  });

  it("check-in from today at the airport (not UTC's day) to today + 100", () => {
    expect(heroDateLimits({ airport: "JFK", night: "", returnDate: "" }, airports, NOW)).toEqual({ min: "2026-10-21", max: "2027-01-29" });
    // 22 Oct 02:30 UTC is still 21 Oct in New York.
    expect(heroDateLimits({ airport: "JFK", night: "", returnDate: "" }, airports, new Date("2026-10-22T02:30:00Z")).min).toBe("2026-10-21");
  });

  it("once a check-in is chosen, the picker also reaches check-in + 60 (never below the check-in limit)", () => {
    expect(heroDateLimits({ airport: "JFK", night: "2027-01-20", returnDate: "" }, airports, NOW).max).toBe("2027-03-21");
    expect(heroDateLimits({ airport: "JFK", night: "2026-10-25", returnDate: "" }, airports, NOW).max).toBe("2027-01-29");
  });

  it("Search: airport + check-in + return go to /park-stay (nothing else, nothing guessed)", () => {
    expect(heroSubmit({ airport: "jfk", night: "2026-11-10", returnDate: "2026-11-14" }, airports, NOW)).toEqual({
      ok: true,
      href: "/park-stay?airport=JFK&night=2026-11-10&returnDate=2026-11-14",
    });
    expect(heroSubmit({ airport: "JFK", night: "2026-10-21", returnDate: "2026-10-22" }, airports, NOW).ok).toBe(true); // today is allowed
  });

  it("Search refuses with the field's reason: no airport, a past check-in, a return before check-in (never swapped), > 60 days", () => {
    const fieldOf = (r: ReturnType<typeof heroSubmit>) => (r.ok ? null : r.problem.field);
    expect(fieldOf(heroSubmit({ airport: "", night: "2026-11-10", returnDate: "2026-11-14" }, airports, NOW))).toBe("airport");
    expect(fieldOf(heroSubmit({ airport: "BOS", night: "2026-11-10", returnDate: "2026-11-14" }, airports, NOW))).toBe("airport");
    expect(fieldOf(heroSubmit({ airport: "JFK", night: "2026-10-20", returnDate: "2026-11-14" }, airports, NOW))).toBe("night");
    expect(fieldOf(heroSubmit({ airport: "JFK", night: "", returnDate: "" }, airports, NOW))).toBe("night");
    const before = heroSubmit({ airport: "JFK", night: "2026-11-10", returnDate: "2026-11-09" }, airports, NOW);
    expect(before).toEqual({ ok: false, problem: { field: "return", message: RETURN_BEFORE_CHECKIN } });
    expect(fieldOf(heroSubmit({ airport: "JFK", night: "2026-11-10", returnDate: "2027-01-10" }, airports, NOW))).toBe("return");
    expect(heroSubmit({ airport: "JFK", night: "2026-11-10", returnDate: "2027-01-09" }, airports, NOW).ok).toBe(true);
  });
});

describe("the parking-card badge (§4, R12-M7)", () => {
  const search = { airport: "JFK", checkin: "2026-11-11", checkout: "2026-11-14" };

  it("shows 'Park & Stay offered here · Add a night' with the focus link — no price, no availability claim", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const html = renderToStaticMarkup(createElement(ParkStayLotBadge, { access: ACCESS, search, reslabLocationId: 132 }));
      expect(html).toContain('href="/park-stay?airport=JFK&amp;night=2026-11-10&amp;returnDate=2026-11-14&amp;focus=doubletree-jfk"');
      expect(html.replace(/<[^>]+>/g, "")).toBe("Park &amp; Stay offered here · Add a night");
      expect(html).not.toMatch(/\$|available|rooms/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("nothing on a same-day search or an unmapped lot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      expect(renderToStaticMarkup(createElement(ParkStayLotBadge, { access: ACCESS, search: { ...search, checkin: "2026-10-21" }, reslabLocationId: 132 }))).toBe("");
      expect(renderToStaticMarkup(createElement(ParkStayLotBadge, { access: ACCESS, search, reslabLocationId: 999 }))).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("its click stops propagation (the mobile map card's root opens the lot slider)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const el = ParkStayLotBadge({ access: ACCESS, search, reslabLocationId: 132 });
      expect(isValidElement(el)).toBe(true);
      const props = (isValidElement(el) ? el.props : {}) as { onClick?: (e: { stopPropagation: () => void }) => void };
      const stopPropagation = vi.fn();
      props.onClick?.({ stopPropagation });
      expect(stopPropagation).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the homepage section's cards (§5)", () => {
  it("one hotel per airport first, then map order, up to four", () => {
    expect(homeCards(ACCESS).map((c) => c.key)).toEqual(["doubletree-jfk", "hyatt-place-flushing-lga", "renaissance-newark-airport", "hampton-inn-jfk"]);
    expect(HOME_CARD_LIMIT).toBe(4);
  });

  it("each card is the response's own photo, name, airport and shuttle line, linking to /park-stay with focus — nothing else", () => {
    expect(homeCards(ACCESS)[0]).toEqual({
      key: "doubletree-jfk",
      airport: "JFK",
      name: "DoubleTree JFK",
      photoUrl: "https://static.cupid.travel/hotels/1.jpg",
      shuttle: "Shuttle every 30 min, 24/7",
      href: "/park-stay?airport=JFK&focus=doubletree-jfk",
    });
  });

  it("hotels at an airport not in the answer are left out; fewer hotels → fewer cards; none → none", () => {
    const one: ParkStayAccess = { airports: [{ code: "EWR", name: "Newark" }], hotels: ACCESS.hotels };
    expect(homeCards(one).map((c) => c.airport)).toEqual(["EWR", "EWR"]);
    expect(homeCards({ airports: ACCESS.airports, hotels: [] })).toEqual([]);
    expect(renderToStaticMarkup(createElement(ParkStayHomeSection, { access: { airports: ACCESS.airports, hotels: [] } }))).toBe("");
  });

  it("the section shows the shuttle lines verbatim, and no price, rating or 'free'", () => {
    const html = renderToStaticMarkup(createElement(ParkStayHomeSection, { access: ACCESS }));
    for (const c of homeCards(ACCESS)) expect(html).toContain(c.shuttle.replace(/&/g, "&amp;"));
    expect(html).toContain('href="/park-stay?airport=LGA&amp;focus=hyatt-place-flushing-lga"');
    expect(html).not.toMatch(/\$\d|\bfree\b|★|\/10|rating/i);
  });
});
