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
import { convertTo24Hour } from "@/lib/utils/time";

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
  const pricingCheckinTime = checkinTime || "10:00 AM";
  const pricingCheckoutTime = checkoutTime || "2:00 PM";

  // Format dates for API
  const checkinTime24 = convertTo24Hour(pricingCheckinTime);
  const checkoutTime24 = convertTo24Hour(pricingCheckoutTime);
  const fromDate = `${defaultCheckin} ${checkinTime24}:00`;
  const toDate = `${defaultCheckout} ${checkoutTime24}:00`;

  // Try to get lot from ResLab API first
  // Pass airport coordinates for distance calculation
  let lot = await getLotById(lotSlug, fromDate, toDate, {
    latitude: airport.latitude,
    longitude: airport.longitude,
  });

  if (!lot) {
    notFound();
  }

  // Build back URL
  const backUrl = `/search?airport=${airport.code}&checkin=${defaultCheckin}&checkout=${defaultCheckout}`;

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
                tag={lot.availability === "limited" ? "Limited Spots" : undefined}
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
  const { checkin, checkout } = await searchParams;

  const airport = getAirportBySlug(slug);

  // Default dates for metadata
  // Note: ResLab requires advance booking, so use tomorrow if no date provided
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const defaultCheckin = checkin || tomorrow.toISOString().split("T")[0];
  const defaultCheckout =
    checkout ||
    new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const fromDate = `${defaultCheckin} 10:00:00`;
  const toDate = `${defaultCheckout} 14:00:00`;

  // Try to get lot
  const lot = await getLotById(lotSlug, fromDate, toDate);

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
