import { describe, it, expect } from "vitest";
import type { UnifiedLot } from "@/types/lot";
import {
  MAX_PUBLISHED_PER_LOT,
  MIN_REVIEWS_FOR_RATING,
  lotReviewKey,
  summarizeReviews,
  withReviews,
  type ReviewRow,
} from "../summary";

let seq = 0;
function row(o: Partial<ReviewRow> = {}): ReviewRow {
  seq++;
  return {
    reslab_location_id: 10,
    direct_lot_id: null,
    rating: 5,
    comment: null,
    publish_consent: false,
    display_name: null,
    shuttle_wait: null,
    extra_charges: null,
    created_at: `2026-10-${String((seq % 28) + 1).padStart(2, "0")}T12:00:00Z`,
    ...o,
  };
}

function lot(o: Partial<UnifiedLot> = {}): UnifiedLot {
  return {
    id: "reslab-10",
    source: "reslab",
    sourceId: "10",
    reslabLocationId: 10,
    name: "Jet Parking JFK",
    slug: "jet-parking-jfk",
    address: "1 Main St",
    city: "Jamaica",
    state: "NY",
    latitude: 40.6,
    longitude: -73.8,
    amenities: [],
    photos: [],
    availability: "available",
    ...o,
  };
}

describe("lotReviewKey", () => {
  it("keys ResLab lots by location id and direct lots by payload id", () => {
    expect(lotReviewKey(lot())).toBe("r:10");
    expect(lotReviewKey(lot({ source: "direct", sourceId: "42", reslabLocationId: undefined }))).toBe("d:42");
    expect(lotReviewKey(lot({ reslabLocationId: undefined }))).toBeNull();
  });
});

describe("summarizeReviews", () => {
  it("withholds the average below the minimum count but still counts", () => {
    const s = summarizeReviews([row({ rating: 5 }), row({ rating: 4 })]).get("r:10")!;
    expect(MIN_REVIEWS_FOR_RATING).toBe(3);
    expect(s.average).toBeNull();
    expect(s.count).toBe(2);
  });

  it("averages every verified review, with or without text, to one decimal", () => {
    const s = summarizeReviews([row({ rating: 5 }), row({ rating: 4 }), row({ rating: 4 })]).get("r:10")!;
    expect(s.average).toBe(4.3);
    expect(s.count).toBe(3);
  });

  it("publishes text only with consent, newest first, capped", () => {
    const rows = [
      row({ comment: "no consent", publish_consent: false }),
      row({ comment: "   ", publish_consent: true }),
      row({ comment: "old", publish_consent: true, display_name: "Ana", created_at: "2026-09-01T00:00:00Z" }),
      row({ comment: " new ", publish_consent: true, created_at: "2026-10-20T00:00:00Z" }),
    ];
    const s = summarizeReviews(rows).get("r:10")!;
    expect(s.published.map((p) => p.comment)).toEqual(["new", "old"]);
    expect(s.published[0].name).toBeNull();
    expect(s.published[1].name).toBe("Ana");

    const many = Array.from({ length: MAX_PUBLISHED_PER_LOT + 3 }, () => row({ comment: "ok", publish_consent: true }));
    expect(summarizeReviews(many).get("r:10")!.published).toHaveLength(MAX_PUBLISHED_PER_LOT);
  });

  it("groups ResLab and direct lots separately and skips rows with no lot", () => {
    const m = summarizeReviews([
      row(),
      row({ reslab_location_id: null, direct_lot_id: "42" }),
      row({ reslab_location_id: null, direct_lot_id: null }),
    ]);
    expect([...m.keys()].sort()).toEqual(["d:42", "r:10"]);
  });
});

describe("withReviews", () => {
  it("returns the same lots untouched when there are no summaries", () => {
    const lots = [lot()];
    expect(withReviews(lots, new Map())).toBe(lots);
  });

  it("sets rating/reviewCount only once the average is shown, and trims text", () => {
    const rows = [1, 2, 3].map(() => row({ rating: 4, comment: "fine", publish_consent: true }));
    const [enriched] = withReviews([lot()], summarizeReviews(rows), 1);
    expect(enriched.rating).toBe(4);
    expect(enriched.reviewCount).toBe(3);
    expect(enriched.reviews?.published).toHaveLength(1);

    const [few] = withReviews([lot()], summarizeReviews([row({ comment: "great", publish_consent: true })]));
    expect(few.rating).toBeUndefined();
    expect(few.reviewCount).toBeUndefined();
    expect(few.reviews?.published[0].comment).toBe("great");
  });
});
