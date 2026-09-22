"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AirportCombobox } from "@/components/shared/airport-combobox";
import { trackBlogCtaClick } from "@/lib/analytics/gtag";
import { DateRangeFieldSkeleton } from "@/components/airport/date-range-field";

// react-day-picker + the Radix Popover it opens in are ~50 KB gzipped and
// only needed once someone actually opens the calendar — keep them out of
// every /blog/[slug] page's initial bundle.
const DateRangeField = dynamic(() => import("@/components/airport/date-range-field"), {
  ssr: false,
  loading: () => <DateRangeFieldSkeleton departDate="" returnDate="" />,
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
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [location, setLocation] = useState(airportCode);
  const [departDate, setDepartDate] = useState("");
  const [returnDate, setReturnDate] = useState("");

  const handleSearch = () => {
    if (!location) return;
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
        <DateRangeField
          departDate={departDate}
          returnDate={returnDate}
          onDepartChange={setDepartDate}
          onReturnChange={setReturnDate}
        />
      </div>

      <Button
        onClick={handleSearch}
        disabled={!location || isLoading}
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
    </div>
  );
}
