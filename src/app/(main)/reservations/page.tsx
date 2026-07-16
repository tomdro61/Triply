"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Navbar } from "@/components/shared/navbar";
import { Footer } from "@/components/shared/footer";
import { ReservationCard } from "@/components/reservations/reservation-card";
import { Calendar, Loader2, Ticket, ArrowLeft, Search } from "lucide-react";
import { isPast, parseISO, isToday } from "date-fns";

interface Booking {
  id: string;
  reslab_reservation_number: string;
  reslab_location_id: number;
  location_name: string;
  location_address: string;
  airport_code: string;
  check_in: string;
  check_out: string;
  grand_total: number;
  triply_service_fee: number | string | null;
  protection_plan_price: number | string | null;
  vehicle_info: {
    make: string;
    model: string;
    color: string;
    licensePlate: string;
  } | null;
  status: "confirmed" | "cancelled" | "completed";
  created_at: string;
}

export default function ReservationsPage() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"upcoming" | "past">("upcoming");
  // Count of bookings made with this account's verified email that aren't
  // linked yet. Surfaced as a one-click "add them" prompt — we never link
  // silently (recycled/changed-email safety).
  const [claimableCount, setClaimableCount] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  useEffect(() => {
    checkAuthAndFetchBookings();
  }, []);

  const checkAuthAndFetchBookings = async () => {
    try {
      // Check if user is logged in
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        // Redirect to login with return URL
        router.push("/auth/login?redirect=/reservations");
        return;
      }

      // Forwarded to each card → confirmation URL → /api/reservations/[id]
      // The API auth check prefers the session, but if it expired between
      // page load and click, the email param keeps the deep-link working.
      setUserEmail(user.email || null);

      // Fetch bookings from API
      const response = await fetch("/api/user/bookings");
      if (!response.ok) {
        if (response.status === 401) {
          router.push("/auth/login?redirect=/reservations");
          return;
        }
        throw new Error("Failed to fetch bookings");
      }

      const data = await response.json();
      setBookings(data.bookings || []);
      setClaimableCount(data.claimableCount || 0);
    } catch (err) {
      console.error("Error fetching bookings:", err);
      setError("Failed to load your reservations. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Claim bookings made under this account's verified email (POST writes the
  // user_id link + an audit row server-side). On success we re-fetch, which
  // moves the claimed bookings into the list and clears the prompt.
  const handleClaim = async () => {
    setClaiming(true);
    setClaimError(null);
    try {
      const response = await fetch("/api/user/link-bookings", { method: "POST" });
      if (!response.ok) {
        if (response.status === 401) {
          router.push("/auth/login?redirect=/reservations");
          return;
        }
        throw new Error("Failed to add bookings");
      }
      const result = await response.json().catch(() => ({}));
      if (result?.disabled) {
        // Kill-switch flipped between page load and click — keep the prompt and
        // tell the user instead of silently clearing it on the refetch.
        setClaimError(
          "Adding bookings is temporarily unavailable. Please try again later."
        );
        return;
      }
      await checkAuthAndFetchBookings();
    } catch (err) {
      console.error("Error claiming bookings:", err);
      setClaimError("We couldn't add those bookings. Please try again.");
    } finally {
      setClaiming(false);
    }
  };

  // Split bookings into upcoming and past
  const upcomingBookings = bookings.filter((booking) => {
    const checkInDate = parseISO(booking.check_in);
    return !isPast(checkInDate) || isToday(checkInDate);
  });

  const pastBookings = bookings.filter((booking) => {
    const checkInDate = parseISO(booking.check_in);
    return isPast(checkInDate) && !isToday(checkInDate);
  });

  const displayedBookings = activeTab === "upcoming" ? upcomingBookings : pastBookings;

  if (loading) {
    return (
      <>
        <Navbar forceSolid />
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="h-12 w-12 animate-spin text-brand-orange mx-auto" />
            <p className="mt-4 text-gray-600">Loading your reservations...</p>
          </div>
        </div>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Navbar forceSolid />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b border-gray-200">
          <div className="max-w-4xl mx-auto px-4 py-6">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Home
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-3 bg-brand-orange/10 rounded-xl">
                <Ticket className="h-8 w-8 text-brand-orange" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">My Reservations</h1>
                <p className="text-gray-600">
                  View and manage your parking reservations
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="max-w-4xl mx-auto px-4 py-6">
          {/* Claim prompt — bookings under this verified email that aren't
              linked yet. One-click, never silent (recycled/changed-email safety). */}
          {claimableCount > 0 && (
            <div className="mb-6 rounded-xl border border-brand-orange/30 bg-brand-orange/5 p-5">
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex items-start gap-3 flex-1">
                  <div className="p-2 bg-brand-orange/10 rounded-lg shrink-0">
                    <Ticket className="h-5 w-5 text-brand-orange" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">
                      We found {claimableCount} reservation
                      {claimableCount === 1 ? "" : "s"} under your email
                    </h3>
                    <p className="text-sm text-gray-600 mt-0.5">
                      {userEmail
                        ? `Bookings made with ${userEmail} aren't linked to your account yet.`
                        : "Some bookings made with your email aren't linked to your account yet."}{" "}
                      Add them to view and manage them here.
                    </p>
                    {claimError && (
                      <p className="text-sm text-red-600 mt-2">{claimError}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={handleClaim}
                  disabled={claiming}
                  className="shrink-0 inline-flex items-center justify-center gap-2 bg-brand-orange text-white font-semibold px-5 py-2.5 rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {claiming ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Adding…
                    </>
                  ) : (
                    "Add to my account"
                  )}
                </button>
              </div>
            </div>
          )}
          {error ? (
            <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-xl">
              {error}
            </div>
          ) : bookings.length === 0 ? (
            // No linked bookings. If there are claimable ones, the prompt above
            // is the whole content; otherwise show the empty state.
            claimableCount > 0 ? null : (
            /* Empty State */
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
              <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <Calendar className="h-10 w-10 text-gray-400" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900 mb-2">
                No reservations yet
              </h2>
              <p className="text-gray-600 mb-6 max-w-md mx-auto">
                You haven't made any parking reservations yet. Find the perfect
                spot for your next trip!
              </p>
              <Link
                href="/"
                className="inline-flex items-center gap-2 bg-brand-orange text-white font-semibold px-6 py-3 rounded-lg hover:bg-orange-600 transition-colors"
              >
                <Search className="h-5 w-5" />
                Find Parking
              </Link>
            </div>
            )
          ) : (
            <>
              {/* Tabs */}
              <div className="flex gap-2 mb-6">
                <button
                  onClick={() => setActiveTab("upcoming")}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    activeTab === "upcoming"
                      ? "bg-brand-orange text-white"
                      : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-200"
                  }`}
                >
                  Upcoming ({upcomingBookings.length})
                </button>
                <button
                  onClick={() => setActiveTab("past")}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    activeTab === "past"
                      ? "bg-brand-orange text-white"
                      : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-200"
                  }`}
                >
                  Past ({pastBookings.length})
                </button>
              </div>

              {/* Bookings List */}
              {displayedBookings.length === 0 ? (
                <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                  <p className="text-gray-600">
                    {activeTab === "upcoming"
                      ? "No upcoming reservations"
                      : "No past reservations"}
                  </p>
                  {activeTab === "upcoming" && (
                    <Link
                      href="/"
                      className="inline-flex items-center gap-2 text-brand-orange font-medium mt-4 hover:text-orange-600"
                    >
                      <Search className="h-4 w-4" />
                      Book your next parking spot
                    </Link>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {displayedBookings.map((booking) => (
                    <ReservationCard key={booking.id} booking={booking} customerEmail={userEmail} />
                  ))}
                </div>
              )}

              {/* Book Another CTA */}
              {activeTab === "upcoming" && upcomingBookings.length > 0 && (
                <div className="mt-8 text-center">
                  <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-brand-orange font-medium hover:text-orange-600"
                  >
                    <Search className="h-4 w-4" />
                    Book another parking spot
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <Footer />
    </>
  );
}
