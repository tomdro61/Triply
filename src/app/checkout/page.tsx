"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ShieldCheck, AlertCircle } from "lucide-react";
import { Navbar, Footer } from "@/components/shared";
import { CheckoutForm } from "@/components/checkout";
import { UnifiedLot } from "@/types/lot";
import { CheckoutCostData } from "@/types/checkout";

interface CheckoutData {
  lot: UnifiedLot;
  costData: CheckoutCostData | null;
  fromDate: string;
  toDate: string;
}

function CheckoutContent() {
  const searchParams = useSearchParams();

  const lotId = searchParams.get("lot");
  const checkIn =
    searchParams.get("checkin") || new Date().toISOString().split("T")[0];
  const checkOut =
    searchParams.get("checkout") ||
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const checkInTime = searchParams.get("checkinTime") || "10:00 AM";
  const checkOutTime = searchParams.get("checkoutTime") || "2:00 PM";

  const [checkoutData, setCheckoutData] = useState<CheckoutData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!lotId) {
      setLoading(false);
      return;
    }

    const fetchCheckoutData = async () => {
      try {
        const params = new URLSearchParams({
          lotId,
          checkin: checkIn,
          checkout: checkOut,
          checkinTime: checkInTime,
          checkoutTime: checkOutTime,
        });

        const response = await fetch(`/api/checkout/lot?${params}`);
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to fetch lot data");
        }

        const data = await response.json();
        setCheckoutData(data);
      } catch (err) {
        console.error("Checkout data fetch error:", err);
        setError(err instanceof Error ? err.message : "Failed to load checkout data");
      } finally {
        setLoading(false);
      }
    };

    fetchCheckoutData();
  }, [lotId, checkIn, checkOut, checkInTime, checkOutTime]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <main className="pt-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-orange mx-auto mb-4" />
              <p className="text-gray-500">Loading checkout...</p>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <main className="pt-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center">
              <AlertCircle size={48} className="mx-auto text-red-500 mb-4" />
              <h1 className="text-2xl font-bold text-gray-900 mb-4">
                Unable to Load Checkout
              </h1>
              <p className="text-gray-600 mb-8">{error}</p>
              <Link
                href="/search"
                className="inline-flex items-center px-6 py-3 bg-brand-orange text-white font-bold rounded-lg hover:bg-orange-600 transition-colors"
              >
                <ChevronLeft size={18} className="mr-2" />
                Back to Search
              </Link>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!lotId || !checkoutData?.lot) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <main className="pt-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-gray-900 mb-4">
                No Parking Lot Selected
              </h1>
              <p className="text-gray-600 mb-8">
                Please select a parking lot from our search results to proceed
                with checkout.
              </p>
              <Link
                href="/search"
                className="inline-flex items-center px-6 py-3 bg-brand-orange text-white font-bold rounded-lg hover:bg-orange-600 transition-colors"
              >
                <ChevronLeft size={18} className="mr-2" />
                Back to Search
              </Link>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  // Check if sold out
  if (checkoutData.costData?.soldOut) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <main className="pt-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center">
              <AlertCircle size={48} className="mx-auto text-amber-500 mb-4" />
              <h1 className="text-2xl font-bold text-gray-900 mb-4">
                This Lot is Sold Out
              </h1>
              <p className="text-gray-600 mb-8">
                Sorry, {checkoutData.lot.name} is no longer available for your selected dates.
                Please search for another parking option.
              </p>
              <Link
                href={`/search?checkin=${checkIn}&checkout=${checkOut}&checkinTime=${encodeURIComponent(checkInTime)}&checkoutTime=${encodeURIComponent(checkOutTime)}`}
                className="inline-flex items-center px-6 py-3 bg-brand-orange text-white font-bold rounded-lg hover:bg-orange-600 transition-colors"
              >
                <ChevronLeft size={18} className="mr-2" />
                Back to Search
              </Link>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />

      <main className="pt-20">
        {/* Header */}
        <div className="bg-white border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
            <div className="flex items-center justify-between">
              <Link
                href={`/search?checkin=${checkIn}&checkout=${checkOut}&checkinTime=${encodeURIComponent(checkInTime)}&checkoutTime=${encodeURIComponent(checkOutTime)}`}
                className="flex items-center text-gray-600 hover:text-brand-orange transition-colors font-medium text-sm"
              >
                <ChevronLeft size={18} className="mr-1" />
                Back to Search
              </Link>
              <div className="flex items-center text-sm text-gray-500">
                <ShieldCheck size={18} className="mr-2 text-green-500" />
                Secure Checkout
              </div>
            </div>
          </div>
        </div>

        {/* Checkout Form */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-8">
            Complete Your Reservation
          </h1>
          <CheckoutForm
            lot={checkoutData.lot}
            checkIn={checkIn}
            checkOut={checkOut}
            checkInTime={checkInTime}
            checkOutTime={checkOutTime}
            costData={checkoutData.costData}
            fromDate={checkoutData.fromDate}
            toDate={checkoutData.toDate}
          />
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
        <p className="text-gray-500">Loading checkout...</p>
      </div>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <CheckoutContent />
    </Suspense>
  );
}
