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
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"upcoming" | "past">("upcoming");

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
    } catch (err) {
      console.error("Error fetching bookings:", err);
      setError("Failed to load your reservations. Please try again.");
    } finally {
      setLoading(false);
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
          {error ? (
            <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-xl">
              {error}
            </div>
          ) : bookings.length === 0 ? (
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
                    <ReservationCard key={booking.id} booking={booking} />
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
