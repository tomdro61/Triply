"use client";

import { Component, type ReactNode } from "react";
import * as Sentry from "@sentry/nextjs";

interface DateRangeFieldErrorBoundaryProps {
  children: ReactNode;
  departDate: string;
  returnDate: string;
  onDepartChange: (value: string) => void;
  onReturnChange: (value: string) => void;
}

interface DateRangeFieldErrorBoundaryState {
  hasError: boolean;
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
  state: DateRangeFieldErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(cause: Error) {
    Sentry.captureException(
      new Error("DateRangeField chunk failed to load", { cause })
    );
  }

  render() {
    if (this.state.hasError) {
      const { departDate, returnDate, onDepartChange, onReturnChange } = this.props;
      return (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Depart</label>
            <input
              type="date"
              value={departDate}
              onChange={(e) => onDepartChange(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Return</label>
            <input
              type="date"
              value={returnDate}
              onChange={(e) => onReturnChange(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-900"
            />
          </div>
        </>
      );
    }

    return this.props.children;
  }
}
