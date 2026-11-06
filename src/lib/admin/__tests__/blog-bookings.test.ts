import { describe, it, expect } from "vitest";
import {
  aggregateBlogBookings,
  blogSlug,
  classifyBooking,
  defaultRange,
  inRange,
  MIN_CLICKS_FLAG,
  netTakeOfDetail,
  rangeDays,
  type BlogBookingRow,
} from "../blog-bookings";

const RANGE = { from: "2026-10-01", to: "2026-10-31" };

let seq = 0;
function row(over: Partial<BlogBookingRow> & { first?: string; last?: string; apt?: string } = {}): BlogBookingRow {
  const { first, last, apt, ...rest } = over;
  const attribution =
    first === undefined && last === undefined && apt === undefined
      ? null
      : {
          v: 1,
          first: { land: first, at: 1_790_000_000 },
          ...(last !== undefined ? { last: { land: last, at: 1_790_000_100 } } : {}),
          ...(apt ? { apt } : {}),
        };
  return {
    id: `b${++seq}`,
    created_at: "2026-10-15T15:00:00Z",
    status: "confirmed",
    airport_code: "JFK",
    attribution,
    ...rest,
  };
}

describe("path → slug", () => {
  it("maps blog paths and full URLs to a lowercase slug", () => {
    expect(blogSlug("/blog/JFK-Parking-Guide")).toBe("jfk-parking-guide");
    expect(blogSlug("https://www.triplypro.com/blog/ewr-cheap-parking/?utm=x")).toBe("ewr-cheap-parking");
    expect(blogSlug("/blog/some%20slug")).toBe("some slug");
  });
  it("is null for non-articles", () => {
    expect(blogSlug("/")).toBeNull();
    expect(blogSlug("/airport/jfk")).toBeNull();
    expect(blogSlug("/blog/airport")).toBeNull();
    expect(blogSlug("/blog/category")).toBeNull();
    expect(blogSlug(undefined)).toBeNull();
  });
});

describe("classifyBooking", () => {
  it("reads first/last touch slugs from valid attribution", () => {
    const b = classifyBooking(row({ first: "/blog/a", last: "/search" }));
    expect(b).toMatchObject({ state: "valid", firstSlug: "a", lastSlug: null, airport: "JFK" });
  });
  it("NULL attribution is 'absent', unparseable is 'invalid'", () => {
    expect(classifyBooking(row()).state).toBe("absent");
    expect(classifyBooking(row({ attribution: { v: null, invalid: true } })).state).toBe("invalid");
    expect(classifyBooking(row({ attribution: { v: 1, first: "garbage" } })).state).toBe("invalid");
  });
  it("airport: booked airport, else cookie apt, else unknown; RESLAB is not an airport", () => {
    expect(classifyBooking(row({ airport_code: "lga", first: "/blog/a", apt: "EWR" })).airport).toBe("LGA");
    expect(classifyBooking(row({ airport_code: "RESLAB", first: "/blog/a", apt: "EWR" })).airport).toBe("EWR");
    expect(classifyBooking(row({ airport_code: null, first: "/blog/a" })).airport).toBe("unknown");
    expect(classifyBooking(row({ airport_code: null })).airport).toBe("unknown");
  });
});

describe("date filter", () => {
  it("uses ET days: 03:30 UTC on Nov 1 is still Oct 31 in New York", () => {
    expect(inRange("2026-11-01T03:30:00Z", RANGE)).toBe(true);
    expect(inRange("2026-11-01T04:30:00Z", RANGE)).toBe(false);
    expect(inRange("2026-10-01T03:59:00Z", RANGE)).toBe(false); // Sept 30, 23:59 ET
    expect(inRange("2026-10-01T04:00:00Z", RANGE)).toBe(true);
    expect(inRange("not a date", RANGE)).toBe(false);
  });
  it("defaultRange is 90 ET days including today", () => {
    const r = defaultRange("2026-11-05");
    expect(r).toEqual({ from: "2026-08-08", to: "2026-11-05" });
    expect(rangeDays(r)).toBe(90);
  });
  it("drops out-of-range rows from every count", () => {
    const rep = aggregateBlogBookings({
      range: RANGE,
      rows: [row({ first: "/blog/a" }), row({ first: "/blog/a", created_at: "2026-09-15T15:00:00Z" })],
    });
    expect(rep.totals.bookings).toBe(1);
    expect(rep.droppedOutOfRange).toBe(1);
    expect(rep.articles.find((a) => a.slug === "a")?.bookings).toBe(1);
  });
});

describe("aggregateBlogBookings", () => {
  it("counts first and last touch separately, either-touch once", () => {
    const rep = aggregateBlogBookings({
      range: RANGE,
      rows: [
        row({ first: "/blog/a", last: "/blog/a" }), // both touches, same article
        row({ first: "/blog/a", last: "/blog/b" }), // both touches, different articles
        row({ first: "/", last: "/blog/b" }), // last only
        row({ first: "/blog/c" }), // first only, no last touch
        row({ first: "/" }), // not blog
      ],
    });
    expect(rep.totals).toMatchObject({ bookings: 5, firstTouchBlog: 3, lastTouchBlog: 3, anyBlog: 4 });
    expect(rep.totals.blogShare).toBeCloseTo(0.8);
    const a = rep.articles.find((x) => x.slug === "a")!;
    expect(a).toMatchObject({ firstTouch: 2, lastTouch: 1, bookings: 2 });
    const b = rep.articles.find((x) => x.slug === "b")!;
    expect(b).toMatchObject({ firstTouch: 0, lastTouch: 2, bookings: 2 });
    expect(rep.articles.find((x) => x.slug === "c")).toMatchObject({ firstTouch: 1, lastTouch: 0, bookings: 1 });
  });

  it("puts missing/invalid attribution in an unknown bucket, not blog or non-blog", () => {
    const rep = aggregateBlogBookings({
      range: RANGE,
      rows: [row(), row({ attribution: { v: null, invalid: true } }), row({ first: "/blog/a" })],
    });
    expect(rep.totals).toMatchObject({ bookings: 3, anyBlog: 1, unknownAbsent: 1, unknownInvalid: 1 });
    expect(rep.airports[0]).toMatchObject({ airport: "JFK", bookings: 3, unknownAbsent: 1, unknownInvalid: 1 });
  });

  it("ignores cancelled and refunded bookings", () => {
    const rep = aggregateBlogBookings({
      range: RANGE,
      rows: [
        row({ first: "/blog/a", status: "cancelled" }),
        row({ first: "/blog/a", status: "refunded" }),
        row({ first: "/blog/a", status: "disputed" }),
      ],
    });
    expect(rep.totals.bookings).toBe(1);
  });

  it("groups by airport with blog share", () => {
    const rep = aggregateBlogBookings({
      range: RANGE,
      rows: [
        row({ first: "/blog/a" }),
        row({ first: "/" }),
        row({ airport_code: "EWR", first: "/blog/b" }),
      ],
    });
    const jfk = rep.airports.find((r) => r.airport === "JFK")!;
    expect(jfk).toMatchObject({ bookings: 2, anyBlog: 1, blogShare: 0.5, gscClicks: null, net: null });
    expect(rep.airports.find((r) => r.airport === "EWR")).toMatchObject({ bookings: 1, anyBlog: 1, blogShare: 1 });
  });

  it("net take: sums known figures over blog bookings, counts unknowns", () => {
    const r1 = row({ first: "/blog/a" });
    const r2 = row({ first: "/blog/a" });
    const r3 = row({ first: "/" });
    const rep = aggregateBlogBookings({
      range: RANGE,
      rows: [r1, r2, r3],
      netById: new Map([
        [r1.id, 15],
        [r3.id, 99], // not a blog booking
      ]),
    });
    expect(rep.totals.net).toEqual({ blogNet: 15, blogNetUnknown: 1 });
    expect(rep.articles.find((a) => a.slug === "a")?.net).toEqual({ blogNet: 15, blogNetUnknown: 1 });
  });

  it("joins Search Console: per-100-click rate, airport clicks via CMS, flags clicks with no bookings", () => {
    const rep = aggregateBlogBookings({
      range: RANGE,
      rows: [row({ first: "/blog/a" }), row({ first: "/blog/a" })],
      gscBySlug: new Map([
        ["a", { clicks: 40, impressions: 1000 }],
        ["quiet", { clicks: MIN_CLICKS_FLAG, impressions: 500 }],
        ["tiny", { clicks: MIN_CLICKS_FLAG - 1, impressions: 50 }],
      ]),
      articleMeta: new Map([
        ["a", { title: "A guide", airport: "JFK" }],
        ["quiet", { title: null, airport: "LGA" }],
      ]),
    });
    const a = rep.articles.find((x) => x.slug === "a")!;
    expect(a).toMatchObject({ title: "A guide", airport: "JFK", gscClicks: 40, bookingsPer100Clicks: 5, flagClicksNoBookings: false });
    expect(rep.articles.find((x) => x.slug === "quiet")).toMatchObject({ bookings: 0, flagClicksNoBookings: true });
    expect(rep.articles.find((x) => x.slug === "tiny")?.flagClicksNoBookings).toBe(false);
    expect(rep.airports.find((r) => r.airport === "JFK")).toMatchObject({ gscClicks: 40, bookingsPer100Clicks: 5 });
    // An airport with Google clicks and no bookings still gets a row.
    expect(rep.airports.find((r) => r.airport === "LGA")).toMatchObject({ bookings: 0, gscClicks: 25, bookingsPer100Clicks: 0 });
  });

  it("without Search Console, no article is flagged and click columns are null", () => {
    const rep = aggregateBlogBookings({ range: RANGE, rows: [row({ first: "/blog/a" })] });
    expect(rep.articles[0]).toMatchObject({ gscClicks: null, bookingsPer100Clicks: null, flagClicksNoBookings: false });
  });
});

describe("netTakeOfDetail", () => {
  it("is the reconciler's triply_total less the ResLab fee on a confirmed row", () => {
    expect(netTakeOfDetail({ status: "confirmed", triply_total: 20, reslab_channel_fee: 2.5, reslab_cancelled: false })).toBe(17.5);
    expect(netTakeOfDetail({ status: "confirmed", triply_total: 20, reslab_channel_fee: 2.5, reslab_cancelled: true })).toBe(20);
    expect(netTakeOfDetail({ status: "confirmed", triply_total: 20, reslab_channel_fee: null, reslab_cancelled: null })).toBe(20);
  });
  it("is null when unknown or not confirmed", () => {
    expect(netTakeOfDetail({ status: "confirmed", triply_total: null, reslab_channel_fee: 1, reslab_cancelled: false })).toBeNull();
    expect(netTakeOfDetail({ status: "disputed", triply_total: 5, reslab_channel_fee: 1, reslab_cancelled: false })).toBeNull();
  });
});
