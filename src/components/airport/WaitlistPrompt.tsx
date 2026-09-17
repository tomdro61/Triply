"use client";

import { useEffect, useState } from "react";
import { addDays, format, parse } from "date-fns";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MAX_ADVANCE_BOOKING_DAYS,
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
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [opensOn, setOpensOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // maxAdvanceBookingDate() is relative to "today" in the LOCAL timezone, so a
  // UTC server and a US browser can disagree by a day. Render nothing until
  // after hydration rather than ship a date that changes under the reader.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // A date handed down from the widget means the customer already tried to pick
  // it — open straight onto the form.
  useEffect(() => {
    if (wantedCheckin) {
      setDate(wantedCheckin);
      setExpanded(true);
    }
  }, [wantedCheckin]);

  if (!mounted) return null;

  const maxDate = maxAdvanceBookingDate();
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
          source: "search",
          page: window.location.pathname,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to join the waitlist");
      }

      setOpensOn(data.opensOn as string);
      setEmail("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Please try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  if (opensOn) {
    return (
      <p
        role="status"
        className="mt-3 flex items-center gap-1.5 text-xs text-green-700"
      >
        <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Done — we&apos;ll email you on{" "}
        {format(parse(opensOn, "yyyy-MM-dd", new Date()), "MMMM d, yyyy")}.
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
