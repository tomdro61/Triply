"use client";

import { Suspense, useState, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Home, Search, AlertCircle } from "lucide-react";
import { Navbar, Footer } from "@/components/shared";
import {
  ConfirmationHeader,
  BookingDetails,
  QRCodeSection,
  AddToCalendar,
  WhatsNext,
} from "@/components/confirmation";
import { getLotById as getMockLotById } from "@/lib/data/mock-lots";
import { UnifiedLot } from "@/types/lot";

interface ConfirmationPageProps {
  params: Promise<{ id: string }>;
}

interface ReservationData {
  id: number;
  reservationNumber: string;
  status: string;
  grandTotal: number;
  dueNow: number;
  dueAtLocation: number;
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  items: Array<{
    type: string;
    fromDate: string;
    toDate: string;
    numberOfDays: number;
    numberOfSpots: number;
  }>;
  location: {
    id: number;
    name: string;
    address: string;
    city: string;
    state: string;
    zipCode: string;
    phone: string;
    latitude: string;
    longitude: string;
  } | null;
  extraFields?: Record<string, string>;
}

function ConfirmationContent({ confirmationId }: { confirmationId: string }) {
  const searchParams = useSearchParams();

  const lotId = searchParams.get("lot");
  const checkInParam = searchParams.get("checkin");
  const checkOutParam = searchParams.get("checkout");
  const checkInTime = searchParams.get("checkinTime") || "10:00 AM";
  const checkOutTime = searchParams.get("checkoutTime") || "2:00 PM";

  const [reservation, setReservation] = useState<ReservationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch reservation data from API
  useEffect(() => {
    const fetchReservation = async () => {
      // Skip API call for mock confirmation IDs (TRP- prefix)
      if (confirmationId.startsWith("TRP-")) {
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/reservations/${confirmationId}`);
        if (response.ok) {
          const data = await response.json();
          setReservation(data.reservation);
        } else {
          // If not found, continue with fallback data
          console.log("Reservation not found in API, using fallback");
        }
      } catch (err) {
        console.error("Error fetching reservation:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchReservation();
  }, [confirmationId]);

  // Get lot data - either from reservation or fallback
  const lot = useMemo<UnifiedLot | null>(() => {
    if (reservation?.location) {
      // Build UnifiedLot from reservation data
      return {
        id: `reslab-${reservation.location.id}`,
        source: "reslab",
        sourceId: String(reservation.location.id),
        reslabLocationId: reservation.location.id,
        name: reservation.location.name,
        slug: reservation.location.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        address: reservation.location.address,
        city: reservation.location.city,
        state: reservation.location.state,
        zipCode: reservation.location.zipCode,
        latitude: parseFloat(reservation.location.latitude),
        longitude: parseFloat(reservation.location.longitude),
        phone: reservation.location.phone,
        photos: [{ id: "1", url: "/placeholder-parking.jpg", alt: reservation.location.name }],
        amenities: [],
        pricing: {
          minPrice: reservation.grandTotal / (reservation.items[0]?.numberOfDays || 1),
          currency: "$",
          currencyCode: "USD",
          parkingTypes: [],
          grandTotal: reservation.grandTotal,
        },
        availability: "available",
      };
    }

    // Fallback to mock data
    if (lotId) {
      return getMockLotById(lotId) || null;
    }

    return null;
  }, [reservation, lotId]);

  // Get booking details from reservation or URL params
  const checkIn = reservation?.items[0]?.fromDate?.split(" ")[0] || checkInParam || new Date().toISOString().split("T")[0];
  const checkOut = reservation?.items[0]?.toDate?.split(" ")[0] || checkOutParam || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  // Calculate days and total
  const { days, total } = useMemo(() => {
    if (reservation) {
      return {
        days: reservation.items[0]?.numberOfDays || 1,
        total: reservation.grandTotal,
      };
    }

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
  }, [checkIn, checkOut, lot, reservation]);

  // Get customer and vehicle info
  const customerName = reservation
    ? `${reservation.customer.firstName} ${reservation.customer.lastName}`
    : "Customer";
  const customerEmail = reservation?.customer.email || "customer@example.com";
  const customerPhone = reservation?.customer.phone || "(555) 123-4567";
  const vehicleInfo = reservation?.extraFields
    ? `${reservation.extraFields.car_make || ""} ${reservation.extraFields.car_model || ""} (${reservation.extraFields.car_color || ""}) - ${reservation.extraFields.license_plate || ""}`.trim()
    : "Vehicle details unavailable";

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <main className="pt-20">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-orange mx-auto mb-4" />
            <p className="text-gray-500">Loading confirmation...</p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!lot) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <main className="pt-20">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <AlertCircle size={48} className="mx-auto text-amber-500 mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-4">
              Booking Not Found
            </h1>
            <p className="text-gray-600 mb-8">
              We couldn't find details for this confirmation. The booking may have been cancelled or the confirmation number is incorrect.
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
            email={customerEmail}
          />

          {/* Main Content Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Left Column */}
            <div className="space-y-6">
              <BookingDetails
                lot={lot}
                checkIn={checkIn}
                checkOut={checkOut}
                checkInTime={checkInTime}
                checkOutTime={checkOutTime}
                days={days}
                total={total}
                customerName={customerName}
                customerEmail={customerEmail}
                customerPhone={customerPhone}
                vehicleInfo={vehicleInfo}
                dueAtLocation={reservation?.dueAtLocation}
              />

              <AddToCalendar
                lot={lot}
                checkIn={checkIn}
                checkOut={checkOut}
                checkInTime={checkInTime}
                checkOutTime={checkOutTime}
                confirmationId={confirmationId}
              />
            </div>

            {/* Right Column */}
            <div className="space-y-6">
              <QRCodeSection
                confirmationId={confirmationId}
                lotName={lot.name}
              />

              <WhatsNext lot={lot} checkIn={checkIn} checkInTime={checkInTime} />
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
