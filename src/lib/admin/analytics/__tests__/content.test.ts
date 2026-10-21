import { describe, it, expect } from "vitest";
import {
  blogBookingsByAirport,
  blogSlug,
  bookingsByArticle,
  change,
  clipWindow,
  contentLists,
  ga4Windows,
  gscWindows,
  purchaseWindow,
  type ArticleRow,
} from "../content";

describe("windows", () => {
  it("GA4: 28 complete ET days ending the day before yesterday, and the 28 before", () => {
    // 2026-10-20 04:30 UTC = Oct 20, 00:30 ET.
    const { current, previous } = ga4Windows(new Date("2026-10-20T04:30:00Z"));
    expect(current).toEqual({ start: "2026-09-21", end: "2026-10-18" });
    expect(previous).toEqual({ start: "2026-08-24", end: "2026-09-20" });
  });

  it("uses the ET date, not UTC, near midnight", () => {
    // 2026-10-20 02:00 UTC is still Oct 19 in New York.
    expect(ga4Windows(new Date("2026-10-20T02:00:00Z")).current.end).toBe("2026-10-17");
  });

  it("Search Console: ends on its last day with data", () => {
    expect(gscWindows("2026-10-17").current).toEqual({ start: "2026-09-20", end: "2026-10-17" });
  });

  it("clips to a start date, and refuses under a week", () => {
    expect(clipWindow({ start: "2026-09-21", end: "2026-10-18" }, "2026-10-07")).toEqual({ start: "2026-10-07", end: "2026-10-18" });
    // Oct 13–18 is six days: too short for a rate.
    expect(clipWindow({ start: "2026-09-21", end: "2026-10-18" }, "2026-10-13")).toBeNull();
    expect(purchaseWindow({ start: "2026-09-21", end: "2026-10-18" })).toBeNull(); // clean from Oct 20
    expect(purchaseWindow({ start: "2026-10-01", end: "2026-10-28" })).toEqual({ start: "2026-10-20", end: "2026-10-28" });
  });
});

describe("blogSlug", () => {
  it.each([
    ["/blog/BWI-Airport-Parking/", "bwi-airport-parking"],
    ["https://www.triplypro.com/blog/jfk-parking?utm=x", "jfk-parking"],
    ["/blog/airport/jfk", null],
    ["/blog/category/tips", null],
    ["/search?airport=JFK", null],
    [null, null],
  ])("%s → %s", (input, slug) => {
    expect(blogSlug(input)).toBe(slug);
  });
});

describe("bookingsByArticle", () => {
  it("credits first/last landing pages; the same article once, two articles half each", () => {
    const m = bookingsByArticle([
      { attribution: { first: { land: "/blog/a" }, last: { land: "/blog/a" } } },
      { attribution: { first: { land: "/blog/a" }, last: { land: "/blog/b" } } },
      { attribution: { first: { land: "/search" } } },
      { attribution: null },
    ]);
    expect(m.get("a")).toBe(1.5);
    expect(m.get("b")).toBe(0.5);
    expect(m.size).toBe(2);
  });
});

describe("blogBookingsByAirport", () => {
  const b = (airport_code: string | null, first?: string, last?: string) => ({
    airport_code,
    attribution: { first: first ? { land: first } : undefined, last: last ? { land: last } : undefined },
  });

  it("groups blog bookings by the airport booked, top articles under each", () => {
    const rows = blogBookingsByAirport([
      b("EWR", "/blog/ewr-a"),
      b("EWR", "/blog/ewr-b"),
      b("EWR", "/blog/ewr-a", "/blog/ewr-c"), // two articles: ½ each
      b("jfk", "/blog/jfk-a"),
      b("JFK", "/search"), // not from the blog: not counted
      b(null, "/blog/x"),
    ]);
    expect(rows.map((r) => [r.airport, r.bookings])).toEqual([
      ["EWR", 3],
      ["JFK", 1],
      ["Unknown", 1],
    ]);
    expect(rows[0].articleCount).toBe(3);
    expect(rows[0].articles).toEqual([
      { slug: "ewr-a", bookings: 1.5 },
      { slug: "ewr-b", bookings: 1 },
      { slug: "ewr-c", bookings: 0.5 },
    ]);
  });

  it("keeps at most 3 articles per airport and 15 airports", () => {
    const many = Array.from({ length: 20 }, (_, i) => b(`A${String(i).padStart(2, "0")}`, `/blog/p${i}`));
    const fourArticles = ["a", "b", "c", "d"].map((s) => b("ZZZ", `/blog/${s}`));
    const rows = blogBookingsByAirport([...many, ...fourArticles]);
    expect(rows).toHaveLength(15);
    expect(rows[0]).toMatchObject({ airport: "ZZZ", bookings: 4 });
    expect(rows[0].articles).toHaveLength(3);
    expect(rows[0].articleCount).toBe(4);
  });

  it("is empty when no booking started on the blog", () => {
    expect(blogBookingsByAirport([b("EWR", "/"), { airport_code: "EWR", attribution: null }])).toEqual([]);
  });
});

const row = (slug: string, sessions: number, bookings: number, sessionsBefore = 0): ArticleRow => ({
  slug,
  sessions,
  sessionsBefore,
  googleClicks: null,
  bookings,
});

describe("contentLists", () => {
  const lists = contentLists([
    row("busy-none", 120, 0, 100),
    row("busy-one", 110, 1),
    row("quiet-two", 10, 2),
    row("mid-two", 40, 2),
    row("tiny-none", 20, 0),
    row("falling", 100, 0, 400),
  ]);

  it("ranks top articles by traffic", () => {
    expect(lists.topByTraffic[0].slug).toBe("busy-none");
  });

  it("lists the most-visited articles with no booking (≥ 50 sessions)", () => {
    expect(lists.trafficFewBookings.map((a) => a.slug)).toEqual(["busy-none", "falling"]);
  });

  it("lists articles with 2+ bookings by bookings per session", () => {
    expect(lists.fewTrafficManyBookings.map((a) => a.slug)).toEqual(["quiet-two", "mid-two"]);
  });

  it("flags articles down 40%+ with ≥ 300 sessions before", () => {
    expect(lists.losingTraffic.map((a) => a.slug)).toEqual(["falling"]);
  });

  it("totals the blog", () => {
    expect(lists.blogSessions).toBe(400);
    expect(lists.blogBookings).toBe(5);
  });
});

describe("change", () => {
  it("is a fraction, or null without a base", () => {
    expect(change(150, 100)).toBe(0.5);
    expect(change(5, 0)).toBeNull();
  });
});
