import { describe, it, expect } from "vitest";
import {
  buildCookieHeaders,
  buildTouch,
  isNewTouch,
  isSkippedPath,
  mergeCookie,
  pageAirport,
  parseStateCookie,
  stripClickIds,
  stripClickIdsFromCookie,
} from "../capture";
import { ATTR_COOKIE, ATTR_STATE_COOKIE } from "../schema";

describe("isSkippedPath — pages that must never count as a touch", () => {
  it.each([
    ["/checkout/complete", true],
    ["/checkout/complete?payment_intent=pi_x", true],
    ["/confirmation/RTL1", true],
    ["/auth/callback", true],
    ["/api/attribution", true],
    ["/admin", true],
    ["/account", true],
    ["/reservations", true],
    ["/partner", true],
    ["/checkout", false],
    ["/search", false],
    ["/new-york-jfk/airport-parking", false],
    ["/", false],
  ])("%s → %s", (path, skipped) => {
    expect(isSkippedPath(path)).toBe(skipped);
  });
});

describe("pageAirport", () => {
  it("reads the airport from an airport or lot page slug", () => {
    expect(pageAirport("/new-york-jfk/airport-parking", "")).toBe("JFK");
    expect(pageAirport("/new-york-jfk/airport-parking/some-lot", "")).toBe("JFK");
    expect(pageAirport("/new-york-lga/airport-parking", "")).toBe("LGA");
  });
  it("reads ?airport= on /search only", () => {
    expect(pageAirport("/search", "?airport=LGA&checkin=2026-10-10")).toBe("LGA");
    expect(pageAirport("/search", "?airport=lga")).toBe("LGA");
    expect(pageAirport("/", "?airport=LGA")).toBeNull();
    expect(pageAirport("/search", "?airport=ZZZ")).toBeNull();
  });
  it("never returns a test airport", () => {
    expect(pageAirport("/search", "?airport=TEST-NY")).toBeNull();
  });
});

describe("buildTouch", () => {
  it("takes UTM + the first click id + referrer HOST + landing path", () => {
    const t = buildTouch({
      pathname: "/new-york-jfk/airport-parking",
      search: "?utm_source=google&utm_medium=cpc&utm_campaign=c&utm_term=t&utm_content=x&gclid=G&fbclid=F",
      referrer: "https://www.google.com/search?q=jfk+parking",
      now: 1758117731000,
    });
    expect(t).toEqual({
      src: "google", med: "cpc", cmp: "c", term: "t", cnt: "x",
      ref: "google.com", land: "/new-york-jfk/airport-parking", click: "gclid:G", at: 1758117731,
    });
  });

  it("caps fields BEFORE the POST so a long ESP/paid URL is truncated, not 413'd", () => {
    const long = "x".repeat(900);
    const t = buildTouch({
      pathname: `/${long}`,
      search: `?utm_source=${long}&utm_medium=${long}&utm_campaign=${long}&utm_term=${long}&utm_content=${long}&gclid=${long}`,
      referrer: "",
    });
    expect(t.src?.length).toBe(100);
    expect(t.term?.length).toBe(64);
    expect(t.cnt?.length).toBe(64);
    expect(t.land?.length).toBe(120);
    expect(t.click?.length).toBe(100);
    expect(JSON.stringify({ touch: t, apt: "JFK" }).length).toBeLessThan(2048);
  });

  it("drops an INTERNAL referrer — the 3DS return and Google sign-in never become a touch", () => {
    expect(buildTouch({ pathname: "/", search: "", referrer: "https://hooks.stripe.com/x" }).ref).toBeUndefined();
    expect(buildTouch({ pathname: "/", search: "", referrer: "https://accounts.google.com/o" }).ref).toBeUndefined();
    expect(buildTouch({ pathname: "/", search: "", referrer: "https://www.triplypro.com/search" }).ref).toBeUndefined();
    expect(buildTouch({ pathname: "/", search: "", referrer: "" }).ref).toBeUndefined();
  });
});

describe("isNewTouch — when the client should POST", () => {
  const direct = buildTouch({ pathname: "/", search: "", referrer: "" });
  const paid = buildTouch({ pathname: "/", search: "?gclid=x", referrer: "" });

  it("no state cookie yet → POST (first visit, even if direct)", () => {
    expect(isNewTouch({ pathname: "/", touch: direct, knownAirport: null, hasStateCookie: false, pageAirport: null })).toBe(true);
  });
  it("cookie exists, direct page view, same airport → no POST", () => {
    expect(isNewTouch({ pathname: "/search", touch: direct, knownAirport: "JFK", hasStateCookie: true, pageAirport: "JFK" })).toBe(false);
  });
  it("a new signal → POST", () => {
    expect(isNewTouch({ pathname: "/", touch: paid, knownAirport: "JFK", hasStateCookie: true, pageAirport: null })).toBe(true);
  });
  it("/search JFK → LGA switch with UNCHANGED pathname → POST (airport update)", () => {
    expect(isNewTouch({ pathname: "/search", touch: direct, knownAirport: "JFK", hasStateCookie: true, pageAirport: "LGA" })).toBe(true);
  });
  it("the second page view of a Google-referred session is NOT a touch once the referrer has been consumed", () => {
    // The component consumes document.referrer once (it never changes across
    // soft navigations); the touch it builds afterwards carries no referrer.
    const internalNav = buildTouch({ pathname: "/search", search: "?airport=JFK", referrer: "" });
    expect(isNewTouch({ pathname: "/search", touch: internalNav, knownAirport: "JFK", hasStateCookie: true, pageAirport: "JFK" })).toBe(false);
  });
  it("skipped paths never POST, even with a signal", () => {
    expect(isNewTouch({ pathname: "/checkout/complete", touch: paid, knownAirport: null, hasStateCookie: false, pageAirport: null })).toBe(false);
  });
});

describe("mergeCookie", () => {
  const first = buildTouch({ pathname: "/a", search: "?utm_source=google&utm_medium=cpc", referrer: "", now: 1000 });
  const later = buildTouch({ pathname: "/b", search: "?utm_source=news&utm_medium=email", referrer: "", now: 2000 });
  const later2 = buildTouch({ pathname: "/c", search: "?utm_source=fb&utm_medium=social", referrer: "", now: 2500 });
  const quiet = buildTouch({ pathname: "/c", search: "", referrer: "", now: 3000 });

  it("first is written once and never overwritten", () => {
    const c1 = mergeCookie(null, first, "JFK");
    const c2 = mergeCookie(c1, later, null);
    expect(c2.first).toEqual(first);
    expect(c2.last).toEqual(later);
    expect(c2.apt).toBe("JFK");
  });
  it("the very first touch sets first only — last stays undefined even with a signal", () => {
    const c = mergeCookie(null, first, null);
    expect(c.last).toBeUndefined();
  });
  it("a later signal REPLACES last, it does not accumulate", () => {
    const c = mergeCookie(mergeCookie(mergeCookie(null, first, null), later, null), later2, null);
    expect(c.last).toEqual(later2);
  });
  it("a signal-less visit does not touch last, but does update apt", () => {
    const c1 = mergeCookie(mergeCookie(null, first, "JFK"), later, null);
    const c2 = mergeCookie(c1, quiet, "LGA");
    expect(c2.last).toEqual(later);
    expect(c2.apt).toBe("LGA");
  });
  it("a first visit with no signal is a direct first touch", () => {
    const c = mergeCookie(null, quiet, null);
    expect(c.first).toEqual(quiet);
    expect(c.last).toBeUndefined();
  });
});

describe("stripClickIds (analytics opt-out)", () => {
  it("removes click ids and keeps UTM/referrer", () => {
    const t = buildTouch({ pathname: "/", search: "?utm_source=g&gclid=x", referrer: "https://google.com" });
    expect(stripClickIds(t)).toEqual({ src: "g", ref: "google.com", land: "/", at: t.at });
  });
  it("stripClickIdsFromCookie scrubs first AND last, nothing else", () => {
    const c = {
      v: 1 as const,
      first: { src: "g", click: "gclid:x", at: 1 },
      last: { src: "f", click: "fbclid:y", at: 2 },
      apt: "JFK",
    };
    expect(stripClickIdsFromCookie(c)).toEqual({ v: 1, first: { src: "g", at: 1 }, last: { src: "f", at: 2 }, apt: "JFK" });
  });
});

describe("cookie headers", () => {
  it("payload is HttpOnly, sentinel is readable; both 30 days, Lax, path /", () => {
    const value = mergeCookie(null, buildTouch({ pathname: "/", search: "", referrer: "" }), "JFK");
    const [payload, sentinel] = buildCookieHeaders(value, true);
    expect(payload.name).toBe(ATTR_COOKIE);
    expect(payload.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 2592000 });
    expect(sentinel.name).toBe(ATTR_STATE_COOKIE);
    expect(sentinel.options.httpOnly).toBe(false);
    expect(sentinel.value).toBe("1|JFK");
    expect(sentinel.value).not.toMatch(/gclid/);
  });
  it("parseStateCookie", () => {
    expect(parseStateCookie("1|JFK")).toEqual({ present: true, apt: "JFK" });
    expect(parseStateCookie("1|")).toEqual({ present: true, apt: null });
    expect(parseStateCookie("garbage")).toEqual({ present: false, apt: null });
    expect(parseStateCookie(undefined)).toEqual({ present: false, apt: null });
  });
});
