"use client";

import { useEffect, useState } from "react";
import { addDays, format, parse } from "date-fns";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MAX_ADVANCE_BOOKING_DAYS,
  MAX_WAITLIST_STAY_DAYS,
  maxAdvanceBookingDate,
} from "@/lib/booking-window";

interface WaitlistPromptProps {
  airportCode: string;
  /** YYYY-MM-DD. A too-far-out date the customer already showed interest in. */
  wantedCheckin?: string;
}

/**
 * The one thing we can offer a traveller whose trip is past ResLab's 60-day
 * wall. They cannot pick their date, they get no explanation, and they leave —
 * so this explains the cap in one line and takes an email instead.
 *
 * Deliberately quiet: small text and a navy link, sitting under the date row.
 * It is a consolation for the minority who hit the cap, not a second call to
 * action competing with the coral Search button.
 */
export function WaitlistPrompt({ airportCode, wantedCheckin }: WaitlistPromptProps) {
  const [expanded, setExpanded] = useState(false);
  const [date, setDate] = useState(wantedCheckin ?? "");
  // Optional return date. Without it, the opens-on email falls back to
  // checkin + 7 days to build a working /search link (see the cron route) —
  // fine as a pricing estimate, but it means the email can only ever name a
  // check-in date, never the traveller's actual trip length. Collecting it
  // up front fixes that for anyone willing to give it.
  const [checkoutDate, setCheckoutDate] = useState("");
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // Both halves of the answer, set together. `message` is the API's own words
  // for the cases where "we'll email you on <date>" would be a lie — today
  // that's the per-email send cap ("we won't send another email today"), which
  // the route returns alongside a perfectly good opensOn. Reading only
  // opensOn dropped it and promised an email that was never going out.
  const [result, setResult] = useState<
    { opensOn: string | null; message: string | null } | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  // maxAdvanceBookingDate() is relative to "today" in the LOCAL timezone, so a
  // UTC server and a US browser can disagree by a day. Render nothing until
  // after hydration rather than ship a date that changes under the reader.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // The server is the single source of truth for the booking window (see
  // GET /api/booking-window) — fetch it on mount so the picker's minimum
  // matches what /api/waitlist will actually accept. Fall back to the local
  // computation while that request is in flight (or if it fails) so the
  // field still works, just with the same drift the fetch exists to fix.
  const [serverMaxDate, setServerMaxDate] = useState<Date | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/booking-window")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { maxDate?: string } | null) => {
        if (cancelled || !data?.maxDate) return;
        const parsed = parse(data.maxDate, "yyyy-MM-dd", new Date());
        setServerMaxDate(parsed);
      })
      .catch(() => {
        /* keep the local fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A date handed down from the widget means the customer already tried to pick
  // it — open straight onto the form.
  useEffect(() => {
    if (wantedCheckin) {
      setDate(wantedCheckin);
      setExpanded(true);
    }
  }, [wantedCheckin]);

  if (!mounted) return null;

  const maxDate = serverMaxDate ?? maxAdvanceBookingDate();
  const firstUnbookable = addDays(maxDate, 1);
  const minDateValue = format(firstUnbookable, "yyyy-MM-dd");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !date || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          airportCode,
          wantedCheckin: date,
          // Only sent when the traveller actually filled it in — the API
          // treats it as optional and falls back to checkin + 7 days itself.
          ...(checkoutDate ? { wantedCheckout: checkoutDate } : {}),
          source: "search",
          page: window.location.pathname,
        }),
      });

      // A 502/504 or WAF page returns HTML, not JSON — check ok + content-type
      // before parsing, so that never surfaces as "Unexpected token '<'".
      const contentType = response.headers.get("content-type") ?? "";
      let data: { error?: string; opensOn?: string; message?: string } | null = null;
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
        throw new Error(message || "Failed to join the waitlist");
      }

      setResult({
        opensOn: data?.opensOn ?? null,
        message: data?.message ?? null,
      });
      setEmail("");
      setCheckoutDate("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  if (result) {
    // The API's own message wins when it sent one: it is the honest account
    // of what happened (e.g. the send cap — row saved, no email today), and
    // the default line below would contradict it.
    const confirmation = result.message
      ? result.message
      : result.opensOn
        ? `Done — we'll email you on ${format(
            parse(result.opensOn, "yyyy-MM-dd", new Date()),
            "MMMM d, yyyy"
          )}.`
        : // A 200 with neither field shouldn't happen, but claiming a date we
          // were never given would be worse than staying vague.
          "Done — you're on the list.";

    return (
      <p
        role="status"
        className="mt-3 flex items-center gap-1.5 text-xs text-green-700"
      >
        <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        {confirmation}
      </p>
    );
  }

  return (
    <div className="mt-3">
      <p className="text-xs text-gray-500">
        Traveling after {format(maxDate, "MMM d")}? Bookings open{" "}
        {MAX_ADVANCE_BOOKING_DAYS} days out — we&apos;ll email you the day{" "}
        {airportCode} opens.{" "}
        {!expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={false}
            aria-controls="waitlist-form"
            className="font-semibold text-navy underline underline-offset-2 hover:text-navy/80"
          >
            Get notified
          </button>
        )}
      </p>

      {expanded && (
        <form
          id="waitlist-form"
          onSubmit={handleSubmit}
          aria-label={`Email me when ${airportCode} opens for my dates`}
          className="mt-2 flex flex-col sm:flex-row gap-2"
        >
          <div className="sm:w-40">
            <label htmlFor="waitlist-date" className="sr-only">
              Travel date
            </label>
            <Input
              id="waitlist-date"
              type="date"
              name="wantedCheckin"
              min={minDateValue}
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setError(null);
              }}
              required
              disabled={isLoading}
              className="h-9 text-sm bg-white"
            />
          </div>

          <div className="sm:w-40">
            <label htmlFor="waitlist-checkout" className="sr-only">
              Return date (optional)
            </label>
            <Input
              id="waitlist-checkout"
              type="date"
              name="wantedCheckout"
              placeholder="Return date"
              // A day after checkin, whatever checkin currently is — matches
              // the API's own "checkout must be after checkin" rule.
              min={
                date
                  ? format(addDays(parse(date, "yyyy-MM-dd", new Date()), 1), "yyyy-MM-dd")
                  : minDateValue
              }
              // …and the other end of that same rule: the API rejects a
              // checkout more than MAX_WAITLIST_STAY_DAYS after check-in, so
              // the picker must not offer one. Without it the field happily
              // collected a mistyped year and the traveller got a 400 on a
              // value the UI had just accepted. Omitted (not left open-ended)
              // until a check-in exists to measure from.
              max={
                date
                  ? format(
                      addDays(parse(date, "yyyy-MM-dd", new Date()), MAX_WAITLIST_STAY_DAYS),
                      "yyyy-MM-dd"
                    )
                  : undefined
              }
              value={checkoutDate}
              onChange={(e) => {
                setCheckoutDate(e.target.value);
                setError(null);
              }}
              disabled={isLoading}
              className="h-9 text-sm bg-white"
            />
          </div>

          <label htmlFor="waitlist-email" className="sr-only">
            Email address
          </label>
          <Input
            id="waitlist-email"
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
            aria-describedby={error ? "waitlist-error" : undefined}
            className="flex-1 h-9 text-sm bg-white"
          />

          <Button
            type="submit"
            disabled={isLoading}
            variant="outline"
            className="h-9 px-4 text-sm font-semibold border-navy/30 text-navy hover:bg-navy/5"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                Saving…
              </>
            ) : (
              "Notify me"
            )}
          </Button>
        </form>
      )}

      {error && (
        <p id="waitlist-error" role="alert" className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
