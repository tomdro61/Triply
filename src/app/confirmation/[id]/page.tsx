"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Home, Search } from "lucide-react";
import { Navbar, Footer } from "@/components/shared";
import {
  ConfirmationHeader,
  BookingDetails,
  QRCodeSection,
  AddToCalendar,
  WhatsNext,
} from "@/components/confirmation";
import { getLotById } from "@/lib/data/mock-lots";

interface ConfirmationPageProps {
  params: Promise<{ id: string }>;
}

function ConfirmationContent({ confirmationId }: { confirmationId: string }) {
  const searchParams = useSearchParams();

  const lotId = searchParams.get("lot") || "jfk-1";
  const checkIn =
    searchParams.get("checkin") || new Date().toISOString().split("T")[0];
  const checkOut =
    searchParams.get("checkout") ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  // Get lot data
  const lot = getLotById(lotId);

  // Calculate days and mock total
  const { days, total } = useMemo(() => {
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const numDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    const dailyRate = lot?.pricing?.minPrice ?? 15;
    const subtotal = dailyRate * numDays;
    const taxes = Math.round(subtotal * 0.08 * 100) / 100;
    return {
      days: numDays,
      total: subtotal + taxes,
    };
  }, [checkIn, checkOut, lot]);

  if (!lot) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <main className="pt-20">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <h1 className="text-2xl font-bold text-gray-900 mb-4">
              Booking Not Found
            </h1>
            <p className="text-gray-600 mb-8">
              We couldn't find details for this confirmation.
            </p>
            <Link
              href="/"
              className="inline-flex items-center px-6 py-3 bg-brand-orange text-white font-bold rounded-lg hover:bg-orange-600 transition-colors"
            >
              <Home size={18} className="mr-2" />
              Return Home
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />

      <main className="pt-20 pb-16">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Confirmation Header */}
          <ConfirmationHeader
            confirmationId={confirmationId}
            email="customer@example.com"
          />

          {/* Main Content Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Left Column */}
            <div className="space-y-6">
              <BookingDetails
                lot={lot}
                checkIn={checkIn}
                checkOut={checkOut}
                days={days}
                total={total}
                customerName="John Doe"
                customerEmail="customer@example.com"
                customerPhone="(555) 123-4567"
                vehicleInfo="Toyota Camry (Black) - ABC1234"
              />

              <AddToCalendar
                lot={lot}
                checkIn={checkIn}
                checkOut={checkOut}
                confirmationId={confirmationId}
              />
            </div>

            {/* Right Column */}
            <div className="space-y-6">
              <QRCodeSection
                confirmationId={confirmationId}
                lotName={lot.name}
              />

              <WhatsNext lot={lot} checkIn={checkIn} />
            </div>
          </div>

          {/* Bottom Actions */}
          <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/"
              className="inline-flex items-center px-6 py-3 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition-colors"
            >
              <Home size={18} className="mr-2" />
              Return Home
            </Link>
            <Link
              href="/search"
              className="inline-flex items-center px-6 py-3 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              <Search size={18} className="mr-2" />
              Book Another
            </Link>
          </div>

          {/* Print-friendly note */}
          <p className="text-center text-sm text-gray-500 mt-8">
            We recommend saving or printing this confirmation for your records.
          </p>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function LoadingState() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-orange mx-auto mb-4" />
        <p className="text-gray-500">Loading confirmation...</p>
      </div>
    </div>
  );
}

export default async function ConfirmationPage({ params }: ConfirmationPageProps) {
  const { id } = await params;

  return (
    <Suspense fallback={<LoadingState />}>
      <ConfirmationContent confirmationId={id} />
    </Suspense>
  );
}
