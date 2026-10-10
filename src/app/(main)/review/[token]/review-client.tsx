"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Star } from "lucide-react";
import { trackReviewSubmitted } from "@/lib/analytics/gtag";
import { REVIEW_COMMENT_MAX, type ShuttleWait } from "@/lib/reviews/schema";
import type { ExistingReview } from "@/lib/reviews/store";

interface ReviewClientProps {
  token: string;
  lotName: string;
  airportCode: string | null;
  bookAgainHref: string;
  bookAgainText: string;
  /** ?r=N from a star link, validated server-side; null when absent/garbled. */
  tappedRating: number | null;
  existing: ExistingReview | null;
}

const SHUTTLE_OPTIONS: { value: ShuttleWait; label: string }[] = [
  { value: "under_5", label: "Under 5 min" },
  { value: "5_15", label: "5–15 min" },
  { value: "over_15", label: "15+ min" },
];

const SUPPORT_EMAIL = "support@triplypro.com";

/** The API's answer, turned into words for the customer. Every non-2xx is
 *  surfaced — never treated as saved. */
function failureMessage(status: number): string {
  if (status === 410) return "This review link has expired.";
  if (status === 401 || status === 403) return "This review link isn't valid any more.";
  if (status === 404 || status === 409) return "This booking can't be reviewed.";
  if (status === 400) return "Something in the form wasn't accepted. Please check it and try again.";
  return "We couldn't save that just now. Please try again.";
}

async function postReview(body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: "We couldn't reach Triply. Check your connection and try again." };
  }
  return res.ok ? { ok: true } : { ok: false, message: failureMessage(res.status) };
}

export default function ReviewClient({
  token,
  lotName,
  airportCode,
  bookAgainHref,
  bookAgainText,
  tappedRating,
  existing,
}: ReviewClientProps) {
  const [rating, setRating] = useState<number | null>(tappedRating ?? existing?.rating ?? null);
  const [ratingState, setRatingState] = useState<"idle" | "saving" | "saved" | "error">(
    existing && tappedRating === null ? "saved" : "idle"
  );
  const [shuttleWait, setShuttleWait] = useState<ShuttleWait | null>(existing?.shuttleWait ?? null);
  const [extraCharges, setExtraCharges] = useState<boolean | null>(existing?.extraCharges ?? null);
  const [comment, setComment] = useState(existing?.comment ?? "");
  const [publishConsent, setPublishConsent] = useState(existing?.publishConsent ?? false);
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const tapRecorded = useRef(false);

  const saveRating = async (n: number) => {
    setRatingState("saving");
    setError(null);
    const result = await postReview({ token, rating: n });
    if (result.ok) {
      setRatingState("saved");
    } else {
      setRatingState("error");
      setError(result.message);
    }
  };

  // Record the star tapped in the email as soon as the page is open, so a
  // single tap counts even if the customer goes no further.
  useEffect(() => {
    if (tapRecorded.current || tappedRating === null) return;
    tapRecorded.current = true;
    if (existing?.rating === tappedRating) {
      setRatingState("saved");
      return;
    }
    void saveRating(tappedRating);
    // saveRating only closes over the token, which never changes on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tappedRating, existing?.rating]);

  const pickRating = (n: number) => {
    setRating(n);
    void saveRating(n);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rating === null) {
      setError("Pick a star rating first.");
      return;
    }
    setSubmitState("submitting");
    setError(null);
    const trimmed = comment.trim();
    const result = await postReview({
      token,
      rating,
      details: {
        shuttleWait,
        extraCharges,
        comment: trimmed ? trimmed : null,
        publishConsent,
      },
    });
    if (!result.ok) {
      setSubmitState("idle");
      setError(result.message);
      return;
    }
    trackReviewSubmitted({ rating, airportCode });
    setSubmitState("done");
  };

  const lowRating = rating !== null && rating <= 2;

  if (submitState === "done") {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-50">
          <Check className="h-6 w-6 text-green-600" />
        </div>
        <h1 className="mt-4 text-2xl font-bold text-gray-900">Thanks for the review</h1>
        <p className="mt-2 text-gray-600">It helps other travellers pick the right lot.</p>
        {lowRating && <SorryLine />}
        <a
          href={bookAgainHref}
          className="mt-6 inline-block rounded-lg bg-brand-orange px-6 py-3 font-semibold text-white hover:bg-orange-600"
        >
          {bookAgainText}
        </a>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-sm md:p-8"
    >
      <h1 className="text-2xl font-bold text-gray-900">How was parking at {lotName}?</h1>

      <div className="mt-5 flex items-center gap-1" role="radiogroup" aria-label="Your rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            onClick={() => pickRating(n)}
            className="rounded p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange"
          >
            <Star
              className={`h-9 w-9 ${rating !== null && n <= rating ? "fill-amber-400 text-amber-400" : "text-gray-300"}`}
            />
          </button>
        ))}
      </div>
      <p className="mt-2 h-5 text-sm text-gray-500" aria-live="polite">
        {ratingState === "saving" && "Saving your rating…"}
        {ratingState === "saved" && "Rating saved. Add a little more below if you like."}
      </p>

      {lowRating && <SorryLine />}

      <fieldset className="mt-6">
        <legend className="text-sm font-semibold text-gray-900">How long was the shuttle wait?</legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {SHUTTLE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={shuttleWait === o.value}
              onClick={() => setShuttleWait(shuttleWait === o.value ? null : o.value)}
              className={`rounded-lg border px-3 py-2 text-sm ${
                shuttleWait === o.value
                  ? "border-brand-orange bg-orange-50 font-semibold text-gray-900"
                  : "border-gray-200 text-gray-700 hover:border-gray-300"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="text-sm font-semibold text-gray-900">Any extra charges at the lot?</legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {[
            { value: true, label: "Yes" },
            { value: false, label: "No" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={extraCharges === o.value}
              onClick={() => setExtraCharges(extraCharges === o.value ? null : o.value)}
              className={`rounded-lg border px-3 py-2 text-sm ${
                extraCharges === o.value
                  ? "border-brand-orange bg-orange-50 font-semibold text-gray-900"
                  : "border-gray-200 text-gray-700 hover:border-gray-300"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="mt-5 block">
        <span className="text-sm font-semibold text-gray-900">Anything else? (optional)</span>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={REVIEW_COMMENT_MAX}
          rows={3}
          className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-brand-orange focus:outline-none focus:ring-1 focus:ring-brand-orange"
          placeholder="One line is plenty"
        />
        <span className="mt-1 block text-right text-xs text-gray-400">
          {comment.length}/{REVIEW_COMMENT_MAX}
        </span>
      </label>

      <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={publishConsent}
          onChange={(e) => setPublishConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[#f87356]"
        />
        OK to show this with my first name
      </label>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitState === "submitting" || rating === null}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-orange px-6 py-3 font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitState === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
        Submit
      </button>

      <a href={bookAgainHref} className="mt-4 block text-center text-sm text-brand-orange hover:text-orange-600">
        {bookAgainText}
      </a>
    </form>
  );
}

function SorryLine() {
  return (
    <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
      Sorry about that — reply to our email or contact{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`} className="font-semibold underline">
        {SUPPORT_EMAIL}
      </a>{" "}
      and we&apos;ll make it right.
    </p>
  );
}
