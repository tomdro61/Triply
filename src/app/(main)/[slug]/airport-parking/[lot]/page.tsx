import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { Navbar, Footer } from "@/components/shared";
import {
  LotHeader,
  LotGallery,
  LotOverview,
  LotAmenities,
  LotLocation,
  BookingWidget,
} from "@/components/lot";
import { JsonLd } from "@/components/seo/JsonLd";
import { getAirportBySlug } from "@/config/airports";
import { getLotById } from "@/lib/reslab/get-lot";
import { limitedSpotsTag } from "@/lib/reslab/availability";
import { airportPricingTimes, reslabLotPricingWindow, toPricingWindow } from "@/lib/reslab/pricing-window";
import type { ReslabPricingWindowFn } from "@/lib/reslab/get-lot";
import { DirectInventoryUnavailableError } from "@/lib/direct/errors";
import type { UnifiedLot } from "@/types/lot";

/**
 * How the lot page PRICES the lot: the URL's times when present and still
 * bookable, otherwise a timezone-aware default — a same-day check-in prices at
 * the earliest slot still open instead of a fixed 10:00 AM, which ResLab
 * rejected as past (the page then showed $0.00/day). A ResLab lot is priced
 * per lot (`pricingWindowFor`: its notice period and timezone, the same rule
 * as search — src/lib/reslab/pricing-window.ts); fromDate/toDate are the
 * airport-level window used for direct lots. Pricing only: the booking widget
 * keeps reading the raw URL times, so none of this becomes a booking time.
 */
function lotPricing(
  checkin: string,
  checkout: string,
  timeZone: string | undefined,
  checkinTime?: string,
  checkoutTime?: string
): { fromDate: string; toDate: string; pricingWindowFor?: ReslabPricingWindowFn } {
  if (!timeZone) {
    // No airport (metadata for an unknown slug renders "Not Found"):
    // pricing-only fallback, never shown as a price for a real lot.
    return toPricingWindow(checkin, checkout, {
      checkinTime: checkinTime || "10:00 AM",
      checkoutTime: checkoutTime || "2:00 PM",
    });
  }
  const input = { checkin, checkout, airportTimeZone: timeZone, checkinTime, checkoutTime, now: new Date() };
  const times = airportPricingTimes(input);
  // Pricing-only fallback (safe — the customer picks real times before
  // checkout): a past check-in or no slot left today can't price at any time.
  // ResLab lots skip the call (pricingWindowFor → null); a direct lot keeps
  // the old literal and renders unpriced, as before.
  const airportWindow = times.ok
    ? toPricingWindow(checkin, checkout, times)
    : toPricingWindow(checkin, checkout, { checkinTime: "10:00 AM", checkoutTime: "2:00 PM" });
  return {
    ...airportWindow,
    pricingWindowFor: (location) => reslabLotPricingWindow(location, input),
  };
}

// A cold-start slug lookup now reaches the ~54-page ResLab sweep through
// getChannelLocationsCached (40s budget, LOCATION_BUILD_BUDGET_MS). The
// invocation ceiling MUST sit above that budget so the build settles and arms
// its circuit breaker — killed mid-sweep it leaves lastBuildFailureAt unset,
// which re-opens the per-request sweep loop behind the 2026-08-10 outage.
// Mirrors the sibling airport page; do not remove because "it works today"
// (it works only while the platform default happens to exceed 40s).
export const maxDuration = 60;

interface LotPageProps {
  params: Promise<{
    slug: string;
    lot: string;
  }>;
  searchParams: Promise<{
    checkin?: string;
    checkout?: string;
    checkinTime?: string;
    checkoutTime?: string;
  }>;
}

function LoadingState() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-orange mx-auto mb-4" />
        <p className="text-gray-500">Loading lot details...</p>
      </div>
    </div>
  );
}

/**
 * The direct-lot inventory read failed and this slug is not a ResLab lot, so
 * we cannot tell "missing" from "unread". Rendered in place rather than
 * rethrown: a rethrow would 500 (and Sentry-capture) every crawl of every
 * direct-lot URL for as long as the read is down, while the store has already
 * reported the root cause once per instance. Never a notFound() and never a
 * noindex — both read as "remove this URL" to Google. This renders inside the
 * page's Suspense boundary, so the status is a 200 with transient copy; the
 * sitemap keeps the URL, and the next crawl after recovery sees the lot.
 */
function UnavailableState({ backUrl }: { backUrl: string }) {
  return (
    <div className="bg-gray-50 min-h-screen">
      <Navbar forceSolid />
      <main className="pt-20 min-h-[60vh] flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <h1 className="text-xl font-bold text-gray-900 mb-2">This lot is temporarily unavailable</h1>
          <p className="text-gray-500 text-sm mb-6">
            We couldn&apos;t load its details just now. This is usually brief — please try again in a moment.
          </p>
          <Link href={backUrl} className="inline-block bg-brand-orange text-white font-semibold text-sm px-5 py-2.5 rounded-full">
            Back to search
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  );
}

async function LotPageContent({ params, searchParams }: LotPageProps) {
  const { slug, lot: lotSlug } = await params;
  const { checkin, checkout, checkinTime, checkoutTime } = await searchParams;

  // Validate airport slug
  const airport = getAirportBySlug(slug);
  if (!airport) {
    notFound();
  }

  // Default dates and times
  // Note: ResLab requires advance booking, so use tomorrow if no date provided
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const defaultCheckin = checkin || tomorrow.toISOString().split("T")[0];
  const defaultCheckout =
    checkout ||
    new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]; // tomorrow + 7 days
  // For pricing lookup only — actual booking times are required to be picked by the user.
  const { fromDate, toDate, pricingWindowFor } = lotPricing(
    defaultCheckin,
    defaultCheckout,
    airport.timezone,
    checkinTime,
    checkoutTime
  );

  // Build back URL
  const backUrl = `/search?airport=${airport.code}&checkin=${defaultCheckin}&checkout=${defaultCheckout}`;

  // Resolve the lot (ResLab or direct). The airport code scopes direct-lot
  // matches to this URL's airport; the coordinates drive the distance shown.
  let lot: UnifiedLot | null;
  try {
    lot = await getLotById(
      lotSlug,
      fromDate,
      toDate,
      { latitude: airport.latitude, longitude: airport.longitude, code: airport.code },
      pricingWindowFor
    );
  } catch (err) {
    if (err instanceof DirectInventoryUnavailableError) return <UnavailableState backUrl={backUrl} />;
    throw err;
  }

  if (!lot) {
    notFound();
  }

  // Structured data for parking facility
  const parkingSchema = {
    "@context": "https://schema.org",
    "@type": "ParkingFacility",
    name: lot.name,
    ...(lot.address && {
      address: {
        "@type": "PostalAddress",
        streetAddress: lot.address,
        ...(lot.city && { addressLocality: lot.city }),
        ...(lot.state && { addressRegion: lot.state }),
        ...(lot.zipCode && { postalCode: lot.zipCode }),
      },
    }),
    ...(lot.latitude &&
      lot.longitude && {
        geo: {
          "@type": "GeoCoordinates",
          latitude: lot.latitude,
          longitude: lot.longitude,
        },
      }),
    ...(lot.pricing?.minPrice && {
      priceRange: `From $${lot.pricing.minPrice.toFixed(2)}/day`,
    }),
    ...(lot.phone && { telephone: lot.phone }),
  };

  const breadcrumbItems = [
    { name: "Home", href: "/" },
    { name: "Airport Parking", href: "/airport-parking" },
    { name: `${airport.city} Airport (${airport.code})`, href: `/${airport.slug}/airport-parking` },
    { name: lot.name, href: null },
  ];

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: breadcrumbItems.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      ...(item.href ? { item: `https://www.triplypro.com${item.href}` } : {}),
    })),
  };

  return (
    <div className="bg-gray-50 min-h-screen">
      <JsonLd data={parkingSchema} />
      <JsonLd data={breadcrumbSchema} />
      <Navbar forceSolid />

      <main className="pt-20 animate-fade-in">
        <nav aria-label="Breadcrumb" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-2">
          <ol className="flex items-center text-sm text-gray-500 flex-wrap">
            {breadcrumbItems.map((item, idx) => (
              <li key={idx} className="flex items-center">
                {idx > 0 && <ChevronRight className="w-4 h-4 mx-2 text-gray-400" />}
                {item.href ? (
                  <Link href={item.href} className="hover:text-brand-orange transition-colors">
                    {item.name}
                  </Link>
                ) : (
                  <span className="text-gray-700 font-medium">{item.name}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <LotHeader lot={lot} backUrl={backUrl} />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-24 lg:pb-8">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left Column: Content */}
            <div className="lg:col-span-2 space-y-8">
              <LotGallery
                photos={lot.photos}
                lotName={lot.name}
                tag={limitedSpotsTag(lot.availability, { checkin, checkout })}
              />
              <LotOverview lot={lot} />
              <LotAmenities amenities={lot.amenities} />
              <LotLocation lot={lot} />
            </div>

            {/* Right Column: Booking Widget */}
            <div className="lg:col-span-1">
              <BookingWidget
                lot={lot}
                initialCheckIn={defaultCheckin}
                initialCheckOut={defaultCheckout}
                initialCheckInTime={checkinTime || ""}
                initialCheckOutTime={checkoutTime || ""}
                airportTimeZone={airport.timezone}
              />
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

export default function LotPage(props: LotPageProps) {
  return (
    <Suspense fallback={<LoadingState />}>
      <LotPageContent {...props} />
    </Suspense>
  );
}

// Generate metadata
export async function generateMetadata({ params, searchParams }: LotPageProps) {
  const { slug, lot: lotSlug } = await params;
  const { checkin, checkout, checkinTime, checkoutTime } = await searchParams;

  const airport = getAirportBySlug(slug);

  // Default dates for metadata
  // Note: ResLab requires advance booking, so use tomorrow if no date provided
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const defaultCheckin = checkin || tomorrow.toISOString().split("T")[0];
  const defaultCheckout =
    checkout ||
    new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  // Same window as the page body (it used a fixed 10:00 AM, a guaranteed 422
  // on every same-day view), so both renders make the same min-price call.
  const { fromDate, toDate, pricingWindowFor } = lotPricing(
    defaultCheckin,
    defaultCheckout,
    airport?.timezone,
    checkinTime,
    checkoutTime
  );

  // Try to get lot. Same airport scope as the page body (the two share one
  // direct-lot read per request via React.cache).
  let lot: UnifiedLot | null;
  try {
    lot = await getLotById(
      lotSlug,
      fromDate,
      toDate,
      airport ? { latitude: airport.latitude, longitude: airport.longitude, code: airport.code } : undefined,
      pricingWindowFor
    );
  } catch (err) {
    // No `robots: noindex` here: that is a removal signal, and this is a
    // transient read failure on a URL we publish (see UnavailableState).
    if (err instanceof DirectInventoryUnavailableError) {
      return { title: "Parking Temporarily Unavailable | Triply" };
    }
    throw err;
  }

  if (!airport || !lot) {
    return {
      title: "Parking Not Found | Triply",
    };
  }

  const description = `Book ${lot.name} near ${airport.name}. ${lot.description?.slice(0, 150) || "Secure, affordable airport parking with free shuttle service."}`;
  const ogImage = lot.photos?.[0]?.url || "/opengraph-image";

  return {
    title: `${lot.name} - ${airport.code} Airport Parking | Triply`,
    description,
    openGraph: {
      title: `${lot.name} - ${airport.code} Airport Parking`,
      description,
      images: [ogImage],
    },
  };
}
