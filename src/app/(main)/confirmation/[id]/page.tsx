"use client";

import { Suspense, useState, useEffect, useMemo, useRef, use } from "react";
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
  CreateAccountPrompt,
} from "@/components/confirmation";
import { UnifiedLot } from "@/types/lot";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { trackPurchase } from "@/lib/analytics/gtag";
import { convertTo12Hour } from "@/lib/utils/time";
import { captureBookingError } from "@/lib/sentry";

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
    shuttleDetails?: string;
    specialConditions?: string;
  } | null;
  vehicleInfo?: {
    make: string;
    model: string;
    color: string;
    licensePlate: string;
    state: string;
  } | null;
  extraFields?: Record<string, string>;
}

function ConfirmationContent({ confirmationId }: { confirmationId: string }) {
  const searchParams = useSearchParams();
  const supabase = createClient();

  const lotId = searchParams.get("lot");
  const checkInParam = searchParams.get("checkin");
  const checkOutParam = searchParams.get("checkout");
  const serviceFeeParam = searchParams.get("serviceFee");
  const emailParam = searchParams.get("email");

  const [reservation, setReservation] = useState<ReservationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchStatus, setFetchStatus] = useState<"ok" | "auth-required" | "not-found" | "error" | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [showAccountPrompt, setShowAccountPrompt] = useState(true);
  const hasFiredPurchase = useRef(false);

  // Track purchase when reservation data loads (fire once)
  useEffect(() => {
    if (reservation?.location && !hasFiredPurchase.current) {
      hasFiredPurchase.current = true;
      trackPurchase({
        confirmationNumber: confirmationId,
        lotId: String(reservation.location.id),
        lotName: reservation.location.name,
        grandTotal: reservation.grandTotal,
        serviceFee: serviceFeeParam ? parseFloat(serviceFeeParam) : undefined,
        airportCode: lotId?.split("-")[0]?.toUpperCase(),
      });
    }
  }, [reservation, confirmationId, serviceFeeParam, lotId]);

  // Check if user is logged in
  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
    };
    getUser();
  }, [supabase.auth]);

  // Fetch reservation data from API. Forward ?email= so guests (not logged in)
  // can authenticate via the email verification path in /api/reservations/[id].
  useEffect(() => {
    const fetchReservation = async () => {
      try {
        const url = emailParam
          ? `/api/reservations/${confirmationId}?email=${encodeURIComponent(emailParam)}`
          : `/api/reservations/${confirmationId}`;
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          setReservation(data.reservation);
          setFetchStatus("ok");
        } else if (response.status === 403) {
          setFetchStatus("auth-required");
        } else if (response.status === 404) {
          setFetchStatus("not-found");
        } else {
          setFetchStatus("error");
          captureBookingError(
            new Error(`Confirmation ${confirmationId} fetch failed with status ${response.status}`),
            { step: "confirmation" }
          );
        }
      } catch (err) {
        setFetchStatus("error");
        const wrapped = err instanceof Error
          ? new Error(`Confirmation ${confirmationId}: ${err.message}`)
          : new Error(`Confirmation ${confirmationId}: ${String(err)}`);
        captureBookingError(wrapped, { step: "confirmation" });
      } finally {
        setLoading(false);
      }
    };

    fetchReservation();
  }, [confirmationId, emailParam]);

  // Get lot data - either from reservation, sessionStorage, or mock data
  const lot = useMemo<UnifiedLot | null>(() => {
    // Try to get stored lot from sessionStorage (has real photos)
    let storedLot: UnifiedLot | null = null;
    if (lotId) {
      try {
        const stored = sessionStorage.getItem(`lot-${lotId}`);
        if (stored) {
          storedLot = JSON.parse(stored) as UnifiedLot;
        }
      } catch {
        // sessionStorage not available or parsing failed
      }
    }

    if (reservation?.location) {
      // Use photos from sessionStorage if available, otherwise placeholder
      const photos = storedLot?.photos?.length
        ? storedLot.photos
        : [{ id: "1", url: "/placeholder-parking.jpg", alt: reservation.location.name }];

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
        shuttleInfo: reservation.location.shuttleDetails
          ? { summary: "", details: reservation.location.shuttleDetails }
          : undefined,
        specialConditions: reservation.location.specialConditions,
        photos,
        amenities: storedLot?.amenities || [],
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

    // Fallback to sessionStorage lot entirely
    if (storedLot) {
      return storedLot;
    }

    return null;
  }, [reservation, lotId]);

  // Get booking details from reservation; fall back to URL date params only.
  // Times come exclusively from the reservation record — never from URL — so
  // a shared/bookmarked confirmation URL cannot misreport the booking time.
  const reservationFrom = reservation?.items[0]?.fromDate || "";
  const reservationTo = reservation?.items[0]?.toDate || "";
  const [reservationCheckIn, reservationCheckInTime24] = reservationFrom.split(" ");
  const [reservationCheckOut, reservationCheckOutTime24] = reservationTo.split(" ");

  const checkIn = reservationCheckIn || checkInParam || new Date().toISOString().split("T")[0];
  const checkOut = reservationCheckOut || checkOutParam || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const checkInTime = convertTo12Hour(reservationCheckInTime24 || "");
  const checkOutTime = convertTo12Hour(reservationCheckOutTime24 || "");

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
  const vehicleInfo = reservation?.vehicleInfo
    ? `${reservation.vehicleInfo.make} ${reservation.vehicleInfo.model} (${reservation.vehicleInfo.color}) - ${reservation.vehicleInfo.licensePlate}`
    : reservation?.extraFields && Object.keys(reservation.extraFields).length > 0
      ? `${reservation.extraFields.car_make || ""} ${reservation.extraFields.car_model || ""} (${reservation.extraFields.car_color || ""}) - ${reservation.extraFields.license_plate || ""}`.trim()
      : undefined;

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar forceSolid />
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

  // Render an error screen for any non-OK fetch result, BEFORE the happy
  // path. Otherwise stale sessionStorage lot data could render the
  // confirmation page with placeholder customer info on a failed fetch.
  if (fetchStatus && fetchStatus !== "ok") {
    let headline: string;
    let message: string;
    if (fetchStatus === "auth-required") {
      headline = "Open Your Confirmation Link";
      message = "To view this booking, please open the confirmation email we sent you and click the View Booking Details button. The link includes the verification we need to load your reservation.";
    } else if (fetchStatus === "error") {
      headline = "Something Went Wrong";
      message = "We had trouble loading your booking. Please try again in a moment, or use the link in your confirmation email.";
    } else {
      headline = "Booking Not Found";
      message = "We couldn't find details for this confirmation. The booking may have been cancelled or the confirmation number is incorrect.";
    }
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar forceSolid />
        <main className="pt-20">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <AlertCircle size={48} className="mx-auto text-amber-500 mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-4">{headline}</h1>
            <p className="text-gray-600 mb-8">{message}</p>
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

  // Fetch succeeded but we still have no lot data (e.g., reservation has no
  // location, or sessionStorage was empty on a re-visit) — fall back to the
  // generic not-found screen rather than rendering placeholders.
  if (!lot) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar forceSolid />
        <main className="pt-20">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <AlertCircle size={48} className="mx-auto text-amber-500 mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-4">Booking Not Found</h1>
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
      <Navbar forceSolid />

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

          {/* Create Account Prompt (for guests only) */}
          {!user && showAccountPrompt && (
            <div className="mt-8">
              <CreateAccountPrompt
                email={customerEmail}
                onClose={() => setShowAccountPrompt(false)}
              />
            </div>
          )}

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

export default function ConfirmationPage({ params }: ConfirmationPageProps) {
  const { id } = use(params);

  return (
    <Suspense fallback={<LoadingState />}>
      <ConfirmationContent confirmationId={id} />
    </Suspense>
  );
}
