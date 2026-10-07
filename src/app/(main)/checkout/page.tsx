"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ShieldCheck, AlertCircle } from "lucide-react";
import { Navbar, Footer } from "@/components/shared";
import { CheckoutForm } from "@/components/checkout";
import { UnifiedLot } from "@/types/lot";
import { CheckoutCostData } from "@/types/checkout";
import {
  trackCheckoutLoadFailed,
  trackCheckoutOpen,
  trackCheckoutView,
} from "@/lib/analytics/gtag";
import { bucketCheckoutFailure, deviceToday, leadDays } from "@/lib/analytics/checkout-funnel";

interface CheckoutData {
  lot: UnifiedLot;
  costData: CheckoutCostData | null;
  fromDate: string;
  toDate: string;
}

function CheckoutContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const lotId = searchParams.get("lot");
  // Default dates use tomorrow (ResLab requires advance booking)
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const checkIn =
    searchParams.get("checkin") || tomorrow.toISOString().split("T")[0];
  const checkOut =
    searchParams.get("checkout") ||
    new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const checkInTime = searchParams.get("checkinTime") || "";
  const checkOutTime = searchParams.get("checkoutTime") || "";

  const [checkoutData, setCheckoutData] = useState<CheckoutData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Checkout-funnel analytics (refs only — nothing here affects rendering or
  // booking). checkout_open fires on mount, before the data load that waits
  // on ResLab, so visitors who leave while it loads are counted; exactly one
  // of checkout_view / checkout_load_failed reports how the load ended.
  const openedAtRef = useRef<number | null>(null);
  const loadReportedRef = useRef(false);
  const loadMs = () =>
    openedAtRef.current === null ? 0 : Math.round(performance.now() - openedAtRef.current);
  const reportLoadFailed = (reason: string, status?: number) => {
    if (loadReportedRef.current) return;
    loadReportedRef.current = true;
    trackCheckoutLoadFailed({ reason, status, loadMs: loadMs() });
  };

  useEffect(() => {
    if (openedAtRef.current !== null) return; // StrictMode re-run
    openedAtRef.current = performance.now();
    trackCheckoutOpen();
  }, []);

  useEffect(() => {
    if (!lotId) {
      reportLoadFailed("no_lot");
      setLoading(false);
      return;
    }
    if (!checkInTime || !checkOutTime) {
      reportLoadFailed("missing_times");
      setError("Please select check-in and check-out times before continuing.");
      setLoading(false);
      return;
    }

    const fetchCheckoutData = async () => {
      let status: number | undefined;
      try {
        const params = new URLSearchParams({
          lotId,
          checkin: checkIn,
          checkout: checkOut,
          checkinTime: checkInTime,
          checkoutTime: checkOutTime,
        });

        const response = await fetch(`/api/checkout/lot?${params}`);
        status = response.status;
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to fetch lot data");
        }

        const data = await response.json();
        setCheckoutData(data);
        if (!data?.lot) {
          reportLoadFailed("no_lot", status);
        } else if (data.costData?.soldOut) {
          reportLoadFailed("sold_out", status);
        } else if (!loadReportedRef.current) {
          loadReportedRef.current = true;
          // Own try: inside the load's try, an analytics throw would turn a
          // successful load into "Unable to Load Checkout".
          try {
            // The RAW check-in: when the URL has none, checkIn is a made-up
            // "tomorrow" and its lead time would be fiction.
            const rawCheckin = searchParams.get("checkin");
            trackCheckoutView({
              lotId: data.lot.id,
              leadDays: rawCheckin ? leadDays(rawCheckin, deviceToday()) : null,
              loadMs: loadMs(),
              priced: data.costData?.costsToken ? 1 : 0,
            });
          } catch {
            // Analytics only — never a checkout failure.
          }
        }
      } catch (err) {
        console.error("Checkout data fetch error:", err);
        setError(err instanceof Error ? err.message : "Failed to load checkout data");
        reportLoadFailed(
          bucketCheckoutFailure({
            status,
            message: err instanceof Error ? err.message : undefined,
            error: err,
          }),
          status
        );
      } finally {
        setLoading(false);
      }
    };

    fetchCheckoutData();
  }, [lotId, checkIn, checkOut, checkInTime, checkOutTime]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar forceSolid />
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
        <Navbar forceSolid />
        <main className="pt-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="text-center">
              <AlertCircle size={48} className="mx-auto text-red-500 mb-4" />
              <h1 className="text-2xl font-bold text-gray-900 mb-4">
                Unable to Load Checkout
              </h1>
              <p className="text-gray-600 mb-8">{error}</p>
              <button
                onClick={() => {
                  if (typeof window !== "undefined" && window.history.length > 1) {
                    router.back();
                  } else {
                    router.push("/search");
                  }
                }}
                className="inline-flex items-center px-6 py-3 bg-brand-orange text-white font-bold rounded-lg hover:bg-orange-600 transition-colors"
              >
                <ChevronLeft size={18} className="mr-2" />
                Go Back
              </button>
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
        <Navbar forceSolid />
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
        <Navbar forceSolid />
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
                href={`/search?checkin=${checkIn}&checkout=${checkOut}`}
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
      <Navbar forceSolid />

      <main className="pt-20">
        {/* Header */}
        <div className="bg-white border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
            <div className="flex items-center justify-between">
              <Link
                href={`/search?checkin=${checkIn}&checkout=${checkOut}`}
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
