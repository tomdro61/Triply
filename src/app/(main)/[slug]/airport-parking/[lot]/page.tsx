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
import { getLotById } from "@/lib/reslab/get-lot";
import { getLotById as getMockLotById } from "@/lib/data/mock-lots";

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

/**
 * Convert 12-hour time format to 24-hour format
 */
function convertTo24Hour(time12h: string): string {
  const [time, modifier] = time12h.split(" ");
  let [hours, minutes] = time.split(":");

  if (hours === "12") {
    hours = modifier === "AM" ? "00" : "12";
  } else if (modifier === "PM") {
    hours = String(parseInt(hours, 10) + 12);
  }

  return `${hours.padStart(2, "0")}:${minutes}`;
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
  const defaultCheckin = checkin || new Date().toISOString().split("T")[0];
  const defaultCheckout =
    checkout ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const defaultCheckinTime = checkinTime || "10:00 AM";
  const defaultCheckoutTime = checkoutTime || "2:00 PM";

  // Format dates for API
  const checkinTime24 = convertTo24Hour(defaultCheckinTime);
  const checkoutTime24 = convertTo24Hour(defaultCheckoutTime);
  const fromDate = `${defaultCheckin} ${checkinTime24}:00`;
  const toDate = `${defaultCheckout} ${checkoutTime24}:00`;

  // Try to get lot from ResLab API first
  let lot = await getLotById(lotSlug, fromDate, toDate);

  // Fallback to mock data if API fails (for development)
  if (!lot) {
    const mockLot = getMockLotById(lotSlug);
    if (mockLot) {
      lot = mockLot;
    }
  }

  if (!lot) {
    notFound();
  }

  // Build back URL
  const backUrl = `/search?airport=${airport.code}&checkin=${defaultCheckin}&checkout=${defaultCheckout}&checkinTime=${encodeURIComponent(defaultCheckinTime)}&checkoutTime=${encodeURIComponent(defaultCheckoutTime)}`;

  return (
    <div className="bg-gray-50 min-h-screen">
      <Navbar forceSolid />

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
                initialCheckInTime={defaultCheckinTime}
                initialCheckOutTime={defaultCheckoutTime}
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
  const defaultCheckin = checkin || new Date().toISOString().split("T")[0];
  const defaultCheckout =
    checkout ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const fromDate = `${defaultCheckin} 10:00:00`;
  const toDate = `${defaultCheckout} 14:00:00`;

  // Try to get lot
  let lot = await getLotById(lotSlug, fromDate, toDate);
  if (!lot) {
    const mockLot = getMockLotById(lotSlug);
    if (mockLot) {
      lot = mockLot;
    }
  }

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
