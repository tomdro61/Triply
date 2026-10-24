/**
 * /review — the review page for the post-trip email.
 *
 * The email links to /review/{token}?r=N, which sets the token as an HttpOnly
 * cookie and redirects here (see ./[token]/route.ts), so the credential never
 * appears in this page's URL — nothing that records URLs (GA4, Clarity,
 * Sentry) can capture it. The token is verified HERE, server-side; an invalid
 * or expired link renders a friendly error and nothing is written.
 *
 * `?r=N` only PRE-SELECTS the star tapped in the email. Nothing is saved until
 * the customer presses Save: mail security scanners open (and some render)
 * every link in an email, and a write on page load would record ratings no
 * one gave. A review that already exists is shown as saved and is never
 * replaced just because an old email link was opened again.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Navbar, Footer } from "@/components/shared";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { isReviewConfigError, REVIEW_COOKIE, verifyReviewToken } from "@/lib/reviews/token";
import { parseRatingParam } from "@/lib/reviews/schema";
import { loadReviewContext } from "@/lib/reviews/store";
import { bookAgainLabel, bookAgainUrl } from "@/lib/reviews/links";
import ReviewClient from "./review-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Rate your parking | Triply",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

interface ReviewPageProps {
  searchParams: Promise<{ r?: string | string[]; link?: string | string[] }>;
}

type ErrorKind = "invalid" | "expired" | "unavailable" | "not_reviewable" | "no_link";

const ERROR_COPY: Record<ErrorKind, { title: string; body: string }> = {
  invalid: {
    title: "This link doesn't look right",
    body: "We couldn't open this review link. Please use the link from your most recent Triply email.",
  },
  expired: {
    title: "This review link has expired",
    body: "Review links stay open for 60 days after your trip. Thanks for thinking of us anyway.",
  },
  unavailable: {
    title: "Something went wrong on our side",
    body: "We couldn't load this page right now. Please try the link again in a little while.",
  },
  not_reviewable: {
    title: "This booking can't be reviewed",
    body: "Reviews are only open for completed stays. If something's not right, contact support@triplypro.com.",
  },
  no_link: {
    title: "Open the link from your email",
    body: "To rate your parking, tap a star in the email we sent after your trip.",
  },
};

const CTX = { endpoint: "/review", method: "GET" as const };

function ErrorState({ kind }: { kind: ErrorKind }) {
  const copy = ERROR_COPY[kind];
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
      <h1 className="text-2xl font-bold text-gray-900">{copy.title}</h1>
      <p className="mt-3 text-gray-600">{copy.body}</p>
    </div>
  );
}

async function resolve(token: string | undefined): Promise<
  | { kind: "error"; error: ErrorKind }
  | { kind: "ok"; ctx: Extract<Awaited<ReturnType<typeof loadReviewContext>>, { kind: "ok" }> }
> {
  if (!token) return { kind: "error", error: "no_link" };
  let verified: ReturnType<typeof verifyReviewToken>;
  try {
    verified = verifyReviewToken(token, Date.now());
  } catch (error) {
    if (isReviewConfigError(error)) {
      captureAPIError(error, { ...CTX, stage: "config" });
      return { kind: "error", error: "unavailable" };
    }
    throw error;
  }
  if (!verified.ok) return { kind: "error", error: verified.reason === "expired" ? "expired" : "invalid" };

  try {
    const supabase = await createAdminClient();
    const ctx = await loadReviewContext(supabase, verified.bookingId);
    if (ctx.kind === "not_found") {
      // Only we can sign tokens: a valid one for a missing booking means a lost
      // row or a signing secret shared across environments.
      captureAPIError(new Error(`review: signed token for a booking that does not exist (${verified.bookingId})`), {
        ...CTX,
        stage: "not_found",
      });
      return { kind: "error", error: "invalid" };
    }
    if (ctx.kind === "not_reviewable") return { kind: "error", error: "not_reviewable" };
    return { kind: "ok", ctx };
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), { ...CTX, stage: "load" });
    return { kind: "error", error: "unavailable" };
  }
}

export default async function ReviewPage({ searchParams }: ReviewPageProps) {
  const { r, link } = await searchParams;
  const result =
    link === "invalid"
      ? ({ kind: "error", error: "invalid" } as const)
      : await resolve((await cookies()).get(REVIEW_COOKIE)?.value);

  return (
    <>
      <Navbar />
      <main className="min-h-[70vh] bg-brand-gray px-4 pb-16 pt-28">
        {result.kind === "error" ? (
          <ErrorState kind={result.error} />
        ) : (
          <ReviewClient
            bookingId={result.ctx.booking.id}
            lotName={result.ctx.booking.lotName}
            airportCode={result.ctx.booking.airportCode}
            bookAgainHref={bookAgainUrl(result.ctx.booking.airportCode, "review_page")}
            bookAgainText={bookAgainLabel(result.ctx.booking.airportCode)}
            tappedRating={parseRatingParam(r)}
            existing={result.ctx.review}
          />
        )}
      </main>
      <Footer />
    </>
  );
}
