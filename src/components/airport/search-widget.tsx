"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AirportCombobox } from "@/components/shared/airport-combobox";
import { trackBlogCtaClick } from "@/lib/analytics/gtag";
import { DateRangeFieldSkeleton } from "@/components/airport/date-range-field-skeleton";
import { DateRangeFieldErrorBoundary } from "@/components/airport/date-range-field-error-boundary";
import { validateSearchDates } from "@/lib/booking-window";

// react-day-picker + the Radix Popover it opens in are ~50 KB gzipped and
// only needed once someone actually opens the calendar — keep them out of
// every /blog/[slug] page's initial bundle. The "compact" (article) variant
// is the one this actually helps, so it's the only one that skips SSR: for
// the "default" (airport hero) variant, `ssr:false` bought nothing but an
// inert, disabled-looking date field above the fold until a second chunk
// landed — SSR it instead so the real fields are there on first paint.
const DateRangeFieldCompact = dynamic(() => import("@/components/airport/date-range-field"), {
  ssr: false,
  loading: () => <DateRangeFieldSkeleton />,
});
const DateRangeFieldDefault = dynamic(() => import("@/components/airport/date-range-field"), {
  loading: () => <DateRangeFieldSkeleton />,
});

interface SearchWidgetProps {
  airportCode: string;
  /**
   * "compact" trims the card for in-article placement: lighter chrome and the
   * two date fields sit side by side on mobile instead of stacking, so the
   * widget stays short enough not to push the article body below the fold.
   */
  variant?: "default" | "compact";
}

export function SearchWidget({ airportCode, variant = "default" }: SearchWidgetProps) {
  const compact = variant === "compact";
  const DateRangeField = compact ? DateRangeFieldCompact : DateRangeFieldDefault;
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [location, setLocation] = useState(airportCode);
  const [departDate, setDepartDateState] = useState("");
  const [returnDate, setReturnDateState] = useState("");
  const [dateError, setDateError] = useState<string | null>(null);

  // Any date edit clears a previous validation message so it never goes stale.
  const setDepartDate = (v: string) => {
    setDateError(null);
    setDepartDateState(v);
  };
  const setReturnDate = (v: string) => {
    setDateError(null);
    setReturnDateState(v);
  };

  const handleSearch = () => {
    if (!location || !departDate || !returnDate) return;
    // Enforce the ResLab booking window and ordering HERE, at the single
    // submit point — the calendar picker already prevents these, but the
    // native-input fallback (error boundary) only hints via min/max, and a
    // typed out-of-window date would otherwise 422 on every lot and read as
    // "search is broken" to the customer (and as a ResLab outage in Sentry).
    const error = validateSearchDates(departDate, returnDate);
    if (error) {
      setDateError(error);
      return;
    }
    setIsLoading(true);

    // "compact" is only used by the blog article booking widget today — the
    // homepage/airport-page variant isn't part of the blog CTA funnel this
    // event tracks.
    if (compact) {
      trackBlogCtaClick({ airportCode: location, placement: "top-widget" });
    }

    const params = new URLSearchParams({
      airport: location,
      ...(departDate && { checkin: departDate }),
      ...(returnDate && { checkout: returnDate }),
    });

    router.push(`/search?${params.toString()}`);
  };

  return (
    <div
      className={
        compact
          ? "bg-white rounded-xl border border-gray-200 shadow-sm p-3 sm:p-4 max-w-3xl mx-auto"
          : "bg-white rounded-2xl shadow-xl p-4 sm:p-6 max-w-3xl mx-auto"
      }
    >
      <div
        className={
          compact
            ? "grid grid-cols-2 sm:grid-cols-3 gap-3"
            : "grid grid-cols-1 sm:grid-cols-3 gap-3"
        }
      >
        {/* Airport */}
        <div className={compact ? "col-span-2 sm:col-span-1" : undefined}>
          <label className="block text-xs font-medium text-gray-500 mb-1.5">Airport</label>
          <AirportCombobox
            value={location}
            onChange={setLocation}
            variant="compact"
          />
        </div>

        {/* Dates */}
        <DateRangeFieldErrorBoundary
          departDate={departDate}
          returnDate={returnDate}
          onDepartChange={setDepartDate}
          onReturnChange={setReturnDate}
        >
          <DateRangeField
            departDate={departDate}
            returnDate={returnDate}
            onDepartChange={setDepartDate}
            onReturnChange={setReturnDate}
          />
        </DateRangeFieldErrorBoundary>
      </div>

      <Button
        onClick={handleSearch}
        disabled={!location || !departDate || !returnDate || isLoading}
        className={`w-full bg-brand-orange hover:bg-brand-orange/90 text-white font-bold ${
          compact ? "mt-3 h-11 text-sm" : "mt-4 h-12 text-base"
        }`}
      >
        {isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          "Search Parking"
        )}
      </Button>
      {dateError ? (
        <p role="alert" className="mt-2 text-xs text-red-600 text-center">
          {dateError}
        </p>
      ) : (
        (!location || !departDate || !returnDate) && (
          <p className="mt-2 text-xs text-gray-500 text-center">
            {!location ? "Pick an airport to search" : "Pick your dates to search"}
          </p>
        )
      )}
    </div>
  );
}
