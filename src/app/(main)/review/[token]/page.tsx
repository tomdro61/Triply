/**
 * /review/[token] — landing page for the post-trip review email.
 *
 * The token is verified HERE, server-side (src/lib/reviews/token.ts); an
 * invalid or expired link renders a friendly error and nothing is written. A
 * star link carries ?r=N: the client records that rating with a POST the
 * moment the page mounts, so a single tap counts even if the customer leaves.
 * It is deliberately NOT written during this server render — mail security
 * scanners (Outlook Safe Links, Mimecast…) GET every link in an email, and a
 * write-on-GET would record all five stars for every recipient behind one.
 */

import type { Metadata } from "next";
import { Navbar, Footer } from "@/components/shared";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { isReviewConfigError, verifyReviewToken } from "@/lib/reviews/token";
import { parseRatingParam } from "@/lib/reviews/schema";
import { loadReviewContext } from "@/lib/reviews/store";
import { bookAgainLabel, bookAgainUrl } from "@/lib/reviews/links";
import ReviewClient from "./review-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Rate your parking | Triply",
  robots: { index: false, follow: false },
  // The URL is a credential for this booking's review — never send it on.
  referrer: "no-referrer",
};

interface ReviewPageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ r?: string | string[] }>;
}

type ErrorKind = "invalid" | "expired" | "unavailable" | "not_reviewable";

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
};

const CTX = { endpoint: "/review/[token]", method: "GET" as const };

function ErrorState({ kind }: { kind: ErrorKind }) {
  const copy = ERROR_COPY[kind];
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
      <h1 className="text-2xl font-bold text-gray-900">{copy.title}</h1>
      <p className="mt-3 text-gray-600">{copy.body}</p>
    </div>
  );
}

async function resolve(token: string): Promise<
  | { kind: "error"; error: ErrorKind }
  | { kind: "ok"; ctx: Extract<Awaited<ReturnType<typeof loadReviewContext>>, { kind: "ok" }> }
> {
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
    if (ctx.kind === "not_found") return { kind: "error", error: "invalid" };
    if (ctx.kind === "not_reviewable") return { kind: "error", error: "not_reviewable" };
    return { kind: "ok", ctx };
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), { ...CTX, stage: "load" });
    return { kind: "error", error: "unavailable" };
  }
}

export default async function ReviewPage({ params, searchParams }: ReviewPageProps) {
  // Next hands dynamic params over already decoded; the token alphabet
  // ([0-9a-zA-Z._-]) never needs escaping anyway.
  const { token } = await params;
  const { r } = await searchParams;
  const result = await resolve(token);

  return (
    <>
      <Navbar />
      <main className="min-h-[70vh] bg-brand-gray px-4 pb-16 pt-28">
        {result.kind === "error" ? (
          <ErrorState kind={result.error} />
        ) : (
          <ReviewClient
            token={token}
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
