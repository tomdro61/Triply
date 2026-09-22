"use client";

import { useState } from "react";
import { Loader2, Mail, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getAirportByCode } from "@/config/airports";
import { trackNewsletterSignup } from "@/lib/analytics/gtag";

interface ArticleEmailCaptureProps {
  airportCode?: string | null;
  slug: string;
}

/**
 * Compact email capture for the end of a blog article — the reader finished
 * the piece and did not book, so this asks for the one thing we can still
 * convert later.
 *
 * Deliberately not the homepage <Newsletter /> block: that one is full-bleed
 * with a background image and would blow out the max-w-3xl article column.
 * Styled navy/gray so it reads as a different offer from the coral booking
 * CTA that sits above and below it.
 *
 * The copy only promises what /api/newsletter actually does: mint a one-time
 * 10% promo code, valid 30 days, emailed to the address given. No claims
 * about list size or "weekly deals" — nothing verifies those.
 */
export function ArticleEmailCapture({ airportCode, slug }: ArticleEmailCaptureProps) {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedMessage, setSubmittedMessage] = useState(
    "Check your inbox — your 10% code is on its way."
  );

  // Only name the airport when it is one we can actually sell — post.airportCode
  // may be null, lowercase, or a code that is catalogued but not enabled.
  const airport = airportCode ? getAirportByCode(airportCode) : undefined;
  const code = airport?.enabled ? airport.code : "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          source: "blog",
          airportCode: code || undefined,
          slug,
        }),
      });

      // A 502/504 or WAF page returns HTML, not JSON — check ok + content-type
      // before parsing, so that never surfaces as "Unexpected token '<'".
      const contentType = response.headers.get("content-type") ?? "";
      let data: { message?: string; error?: string; alreadySubscribed?: boolean } | null = null;
      if (contentType.includes("application/json")) {
        try {
          data = await response.json();
        } catch {
          data = null;
        }
      }

      if (!response.ok) {
        const message =
          response.status >= 500
            ? "Something went wrong. Please try again."
            : data?.error;
        throw new Error(message || "Failed to send your code");
      }

      setSubmittedMessage(data?.message || "Check your inbox — your 10% code is on its way.");
      setIsSubmitted(true);
      // Already-subscribed responses didn't send a new email or mint a code
      // for a genuinely new lead — don't inflate generate_lead with them.
      if (!data?.alreadySubscribed) {
        trackNewsletterSignup({ source: "blog", airportCode: code || null });
      }
      setEmail("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <aside
      id="email-capture"
      aria-labelledby="email-capture-heading"
      className="not-prose my-10 rounded-2xl border border-gray-200 bg-gray-50 px-6 py-7"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="hidden sm:flex w-10 h-10 shrink-0 items-center justify-center rounded-full bg-navy/10"
        >
          <Mail className="w-5 h-5 text-navy" />
        </span>

        <div className="flex-1 min-w-0">
          <h2
            id="email-capture-heading"
            className="text-xl font-heading font-bold text-navy"
          >
            Get 10% off your first {code ? `${code} ` : ""}parking booking
          </h2>
          <p className="mt-2 text-gray-600">
            Drop your email and we&apos;ll send a one-time 10% code, good for 30 days.
          </p>

          {isSubmitted ? (
            <p
              role="status"
              className="mt-4 flex items-center gap-2 text-green-700 font-medium"
            >
              <Check className="w-5 h-5 shrink-0" aria-hidden="true" />
              {submittedMessage}
            </p>
          ) : (
            <form
              onSubmit={handleSubmit}
              aria-label="Email me a 10% off code"
              className="mt-4 flex flex-col sm:flex-row gap-3"
            >
              <label htmlFor="email-capture-input" className="sr-only">
                Email address
              </label>
              <Input
                id="email-capture-input"
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                required
                disabled={isLoading}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "email-capture-error" : undefined}
                className="flex-1 h-11 bg-white"
              />
              <Button
                type="submit"
                disabled={isLoading}
                aria-label="Send my 10% off code"
                className="h-11 px-6 bg-navy text-white font-semibold hover:bg-navy/90"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    Sending…
                  </>
                ) : (
                  "Send my code"
                )}
              </Button>
            </form>
          )}

          {error && (
            <p id="email-capture-error" role="alert" className="mt-2 text-sm text-red-600">
              {error}
            </p>
          )}

          {!isSubmitted && (
            <p className="mt-3 text-xs text-gray-500">No spam. Unsubscribe anytime.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
