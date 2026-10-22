import { Star, BadgeCheck } from "lucide-react";
import type { LotReviewSummary, PublishedReview } from "@/lib/reviews/summary";
import type { ShuttleWait } from "@/lib/reviews/schema";

interface LotReviewsProps {
  reviews: LotReviewSummary | undefined;
}

const SHUTTLE_WAIT_LABEL: Record<ShuttleWait, string> = {
  under_5: "Shuttle wait under 5 min",
  "5_15": "Shuttle wait 5–15 min",
  over_15: "Shuttle wait over 15 min",
};

function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <span className="flex items-center" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={size}
          className={n <= Math.round(rating) ? "text-yellow-400 fill-yellow-400" : "text-gray-200 fill-gray-200"}
        />
      ))}
    </span>
  );
}

function reviewMonth(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function ReviewItem({ review }: { review: PublishedReview }) {
  const facts = [
    review.shuttleWait ? SHUTTLE_WAIT_LABEL[review.shuttleWait] : null,
    review.extraCharges === false ? "No surprise charges" : null,
  ].filter((f): f is string => f !== null);
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2 mb-1">
        <Stars rating={review.rating} />
        <span className="sr-only">Rated {review.rating} out of 5</span>
        <span className="text-sm font-semibold text-gray-900">{review.name ?? "Verified guest"}</span>
        <span className="text-xs text-gray-400">{reviewMonth(review.createdAt)}</span>
      </div>
      <p className="text-gray-700 text-sm leading-relaxed whitespace-pre-line">{review.comment}</p>
      {facts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {facts.map((f) => (
            <span key={f} className="text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-full px-2 py-0.5">
              {f}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * Verified Triply guest reviews (booking_reviews). Renders nothing until the
 * lot has at least one review with consented text; the average shows only
 * once it is computed from enough reviews (MIN_REVIEWS_FOR_RATING).
 */
export function LotReviews({ reviews }: LotReviewsProps) {
  if (!reviews || reviews.published.length === 0) return null;
  return (
    <section id="reviews" className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-xl font-bold text-gray-900">Guest Reviews</h2>
        {reviews.average !== null && (
          <div className="flex items-center gap-2">
            <Stars rating={reviews.average} size={16} />
            <span className="font-bold text-gray-900">{reviews.average.toFixed(1)}</span>
            <span className="text-sm text-gray-500">({reviews.count} reviews)</span>
          </div>
        )}
      </div>
      <p className="flex items-center text-xs text-gray-500 mb-4">
        <BadgeCheck size={14} className="text-green-600 mr-1 shrink-0" />
        Every review is from a guest who booked this lot on Triply and completed their stay.
      </p>
      <ul className="divide-y divide-gray-100">
        {reviews.published.map((r) => (
          <ReviewItem key={`${r.createdAt}-${r.rating}`} review={r} />
        ))}
      </ul>
    </section>
  );
}
