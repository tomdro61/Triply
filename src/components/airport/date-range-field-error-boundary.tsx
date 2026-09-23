"use client";

import { Component, type ReactNode } from "react";
import * as Sentry from "@sentry/nextjs";
import { format } from "date-fns";
import { maxAdvanceBookingDate } from "@/lib/booking-window";

// Matches `ChunkLoadError` (webpack/next's own error name for a failed
// `import()`) or the message Safari/older browsers throw for the same
// failure via native dynamic import. Anything else that lands in this
// boundary is a real render bug in DateRangeField, not CDN/chunk noise, and
// must not be triaged as one.
const CHUNK_LOAD_ERROR_PATTERN = /Loading chunk|dynamically imported module/i;

function isChunkLoadError(error: Error): boolean {
  return error.name === "ChunkLoadError" || CHUNK_LOAD_ERROR_PATTERN.test(error.message);
}

/**
 * yyyy-MM-dd bounds for the native `<input type="date">` fallback — matches
 * DateRangeField's `minDate={new Date()}` / `maxDate={maxAdvanceBookingDate()}`
 * (see booking-window.ts: ResLab 422s on a check-in date outside this window).
 * Exported so the bounds can be asserted directly in tests without rendering.
 */
export function getFallbackDateBounds(): { min: string; max: string } {
  return {
    min: format(new Date(), "yyyy-MM-dd"),
    max: format(maxAdvanceBookingDate(), "yyyy-MM-dd"),
  };
}

/**
 * A return date that now precedes the newly chosen depart date describes a
 * reversed range — clear it rather than letting the reader submit one.
 */
export function nextReturnDateAfterDepartChange(
  newDepartDate: string,
  currentReturnDate: string
): string {
  if (currentReturnDate && newDepartDate && currentReturnDate < newDepartDate) {
    return "";
  }
  return currentReturnDate;
}

interface DateRangeFieldErrorBoundaryProps {
  children: ReactNode;
  departDate: string;
  returnDate: string;
  onDepartChange: (value: string) => void;
  onReturnChange: (value: string) => void;
}

interface DateRangeFieldErrorBoundaryState {
  hasError: boolean;
  wasChunkFailure: boolean;
}

/**
 * Local error boundary around the lazy-loaded DateRangeField chunk.
 * `next/dynamic` is `React.lazy` underneath: if the chunk request fails
 * (chunk rotation across a deploy while a CDN/ISR-cached page sits in a tab,
 * flaky mobile, script blockers) it throws during render. Without a local
 * boundary, the nearest one is `(main)/error.tsx`, which takes down the
 * entire article — or, via hero-section.tsx, the whole airport landing page
 * — even though the rest of the page (SSR'd content) is perfectly readable.
 *
 * The fallback is two native `<input type="date">` wired to the same
 * depart/return setters SearchWidget passes DateRangeField, so a reader can
 * still search with zero extra JS.
 *
 * `ChunkLoadError` / "Loading chunk N failed" are in
 * instrumentation-client.ts's Sentry `ignoreErrors` list (usually harmless
 * stale-tab noise), so we re-report as a fresh Error with `cause` to get
 * past that filter — this one IS actionable, since it's silently degrading
 * the booking widget on every article and every airport landing page.
 */
export class DateRangeFieldErrorBoundary extends Component<
  DateRangeFieldErrorBoundaryProps,
  DateRangeFieldErrorBoundaryState
> {
  state: DateRangeFieldErrorBoundaryState = { hasError: false, wasChunkFailure: false };

  static getDerivedStateFromError(cause: Error) {
    return { hasError: true, wasChunkFailure: isChunkLoadError(cause) };
  }

  componentDidCatch(cause: Error) {
    const chunkFailure = isChunkLoadError(cause);
    Sentry.withScope((scope) => {
      scope.setTag("component", "DateRangeField");
      scope.setTag("dateRangeField.chunkFailure", String(chunkFailure));
      Sentry.captureException(
        new Error(
          chunkFailure
            ? "DateRangeField chunk failed to load"
            : "DateRangeField render error",
          { cause }
        )
      );
    });
  }

  private handleDepartChange = (value: string) => {
    const { returnDate, onDepartChange, onReturnChange } = this.props;
    onDepartChange(value);
    const nextReturn = nextReturnDateAfterDepartChange(value, returnDate);
    if (nextReturn !== returnDate) {
      onReturnChange(nextReturn);
    }
  };

  /**
   * A transient chunk failure (flaky network, a deploy racing a cached tab)
   * shouldn't permanently downgrade the widget for the rest of the session —
   * let the reader retry the real picker. Render-bug failures are excluded:
   * DateRangeField would just throw again immediately.
   */
  private handleRetry = () => {
    this.setState({ hasError: false, wasChunkFailure: false });
  };

  render() {
    if (this.state.hasError) {
      const { departDate, returnDate, onReturnChange } = this.props;
      const { min, max } = getFallbackDateBounds();
      return (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Depart</label>
            <input
              type="date"
              value={departDate}
              min={min}
              max={max}
              onChange={(e) => this.handleDepartChange(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Return</label>
            <input
              type="date"
              value={returnDate}
              min={departDate || min}
              max={max}
              onChange={(e) => onReturnChange(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-900"
            />
          </div>
          {this.state.wasChunkFailure && (
            <button
              type="button"
              onClick={this.handleRetry}
              className="col-span-full text-xs text-gray-400 underline underline-offset-2 hover:text-gray-600 text-left"
            >
              Try the calendar picker again
            </button>
          )}
        </>
      );
    }

    return this.props.children;
  }
}
