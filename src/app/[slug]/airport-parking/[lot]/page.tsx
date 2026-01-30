import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Navbar, Footer } from "@/components/shared";
import {
  LotHeader,
  LotGallery,
  LotOverview,
  LotAmenities,
  LotLocation,
  BookingWidget,
} from "@/components/lot";
import { getAirportBySlug } from "@/config/airports";
import { getLotById } from "@/lib/data/mock-lots";

interface LotPageProps {
  params: Promise<{
    slug: string;
    lot: string;
  }>;
  searchParams: Promise<{
    checkin?: string;
    checkout?: string;
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
  const { checkin, checkout } = await searchParams;

  // Validate airport slug
  const airport = getAirportBySlug(slug);
  if (!airport) {
    notFound();
  }

  // Get lot data directly from mock data
  const lot = getLotById(lotSlug);
  if (!lot) {
    notFound();
  }

  // Default dates
  const defaultCheckin =
    checkin || new Date().toISOString().split("T")[0];
  const defaultCheckout =
    checkout ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  // Build back URL
  const backUrl = `/search?airport=${airport.code}&checkin=${defaultCheckin}&checkout=${defaultCheckout}`;

  return (
    <div className="bg-gray-50 min-h-screen">
      <Navbar />

      <main className="pt-20 animate-fade-in">
        <LotHeader lot={lot} backUrl={backUrl} />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
export async function generateMetadata({ params }: LotPageProps) {
  const { slug, lot: lotSlug } = await params;

  const airport = getAirportBySlug(slug);
  const lot = getLotById(lotSlug);

  if (!airport || !lot) {
    return {
      title: "Parking Not Found | Triply",
    };
  }

  return {
    title: `${lot.name} - ${airport.code} Airport Parking | Triply`,
    description: `Book ${lot.name} near ${airport.name}. ${lot.description?.slice(0, 150) || "Secure, affordable airport parking with free shuttle service."}`,
  };
}
