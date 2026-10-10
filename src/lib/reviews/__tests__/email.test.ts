import { describe, it, expect } from "vitest";
import { buildReviewEmail, reviewIdempotencyKey } from "../email";
import { bookAgainUrl } from "../links";
import { verifyReviewToken } from "../token";
import type { ReviewCandidate } from "../select";

const c: ReviewCandidate = {
  bookingId: "3f2b8c1e-9a4d-4e2b-8c7a-1d2e3f4a5b6c",
  kind: "initial",
  email: "sam@example.com",
  firstName: "Sam",
  lotName: "Jet <Parking> JFK",
  airportCode: "JFK",
  checkoutDate: "2026-10-09",
};
const NOW = Date.UTC(2026, 9, 9, 23, 0);

describe("buildReviewEmail", () => {
  it("has the lot in the subject and five signed star links, ?r=1..5", () => {
    const { subject, text, html } = buildReviewEmail(c);
    expect(subject).toBe("How was parking at Jet <Parking> JFK?");
    const links = [...text.matchAll(/https:\/\/www\.triplypro\.com\/review\/([^?\s]+)\?r=(\d)/g)];
    expect(links.map((m) => m[2])).toEqual(["1", "2", "3", "4", "5"]);
    for (const m of links) {
      const v = verifyReviewToken(m[1], NOW);
      expect(v.ok && v.bookingId).toBe(c.bookingId);
    }
    // HTML-escaped lot name; no raw tag.
    expect(html).toContain("Jet &lt;Parking&gt; JFK");
    expect(html).not.toContain("<Parking>");
  });

  it("is byte-identical across rebuilds (Resend idempotency payload)", () => {
    expect(buildReviewEmail(c)).toEqual(buildReviewEmail(c));
  });

  it("links 'book again' to the airport page with email UTMs", () => {
    const { html } = buildReviewEmail(c);
    const url = new URL(bookAgainUrl("JFK"));
    expect(url.pathname).toBe("/new-york-jfk/airport-parking");
    expect(url.searchParams.get("utm_medium")).toBe("email");
    expect(url.searchParams.get("utm_campaign")).toBe("review");
    expect(html).toContain("Book your next trip at JFK");
  });

  it("falls back to the home page when the airport is unknown", () => {
    const { html } = buildReviewEmail({ ...c, airportCode: null });
    expect(new URL(bookAgainUrl(null)).pathname).toBe("/");
    expect(html).toContain("Book your next trip");
    expect(html).not.toContain("trip at");
  });

  it("uses its own subject for the reminder and its own idempotency key", () => {
    expect(buildReviewEmail({ ...c, kind: "reminder" }).subject).toBe("Quick one: how was Jet <Parking> JFK?");
    expect(reviewIdempotencyKey(c.bookingId, "initial")).not.toBe(reviewIdempotencyKey(c.bookingId, "reminder"));
  });
});
