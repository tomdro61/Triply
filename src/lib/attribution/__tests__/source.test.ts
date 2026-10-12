import { describe, it, expect } from "vitest";
import { bookingSource, bookingSourceLabel, BOOKING_SOURCES, BOOKING_SOURCE_LABELS } from "../source";
import type { AttributionRow } from "../display";

type First = NonNullable<NonNullable<AttributionRow["attribution"]>["first"]>;
const row = (channel: string | null, first?: First): AttributionRow => ({
  channel,
  attribution: first ? { v: 1, first } : null,
});

// Shapes copied from production rows (Sept 17 – Oct 11, 2026).
describe("bookingSource", () => {
  it("AI assistants are split out of whatever channel stored them", () => {
    expect(bookingSource(row("referral", { src: "chatgpt.com", land: "/blog/x" }))).toBe("chatgpt");
    expect(bookingSource(row("referral", { src: "chatgpt.com", ref: "chatgpt.com" }))).toBe("chatgpt");
    expect(bookingSource(row("referral", { src: "gemini" }))).toBe("gemini");
    // gemini.google.com is stored as organic_search and must not read as Google
    expect(bookingSource(row("organic_search", { ref: "gemini.google.com" }))).toBe("gemini");
    expect(bookingSource(row("referral", { src: "copilot.com", ref: "copilot.microsoft.com" }))).toBe("copilot");
    expect(bookingSource(row("referral", { ref: "perplexity.ai" }))).toBe("other_ai");
    expect(bookingSource(row("referral", { ref: "claude.ai" }))).toBe("other_ai");
  });

  it("search splits Google from every other engine", () => {
    expect(bookingSource(row("organic_search", { ref: "google.com" }))).toBe("google");
    expect(bookingSource(row("organic_search", { ref: "www.google.co.uk" }))).toBe("google");
    expect(bookingSource(row("organic_search", { ref: "ucs-widget.corp.google.com" }))).toBe("google");
    for (const ref of ["bing.com", "duckduckgo.com", "search.yahoo.com", "search.brave.com", "ecosia.org"]) {
      expect(bookingSource(row("organic_search", { ref }))).toBe("other_search");
    }
  });

  it("the Android Google app arrives as a referral and is Google", () => {
    expect(bookingSource(row("referral", { ref: "com.google.android.googlequicksearchbox" }))).toBe("google");
    expect(bookingSource(row("referral", { ref: "someblog.example" }))).toBe("referral");
  });

  it("no referrer: a deep blog landing is kept apart from direct", () => {
    expect(bookingSource(row("direct", { land: "/blog/newark-airport-parking-p6" }))).toBe("no_referrer_blog");
    expect(bookingSource(row("direct", { land: "/" }))).toBe("direct");
    expect(bookingSource(row("direct", { land: "/search" }))).toBe("direct");
    expect(bookingSource(row("direct", { land: "/blog" }))).toBe("direct"); // the index, not an article
    expect(bookingSource(row("direct"))).toBe("direct"); // channel present, no attribution blob
  });

  it("the remaining channels map one to one", () => {
    expect(bookingSource(row("email", { src: "triply", med: "email", cmp: "checkout_recovery" }))).toBe("email");
    expect(bookingSource(row("paid_search", { click: "gclid:abc" }))).toBe("paid");
    expect(bookingSource(row("paid_social"))).toBe("paid");
    expect(bookingSource(row("organic_social", { ref: "facebook.com" }))).toBe("social");
    expect(bookingSource(row("partner"))).toBe("partner");
  });

  it("invalid and unknown stay distinct from direct", () => {
    expect(bookingSource({ channel: null, attribution: { v: null, invalid: true } })).toBe("invalid");
    expect(bookingSource(row(null))).toBe("unknown");
    expect(bookingSource(row(""))).toBe("unknown");
    expect(bookingSource(row("Organic_Search", { ref: "google.com" }))).toBe("unknown");
  });

  it("every source has a label", () => {
    for (const s of BOOKING_SOURCES) expect(BOOKING_SOURCE_LABELS[s]).toMatch(/\S/);
    expect(bookingSourceLabel(row("referral", { src: "chatgpt.com" }))).toBe("ChatGPT");
  });
});
