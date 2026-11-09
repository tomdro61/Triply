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
  ProtectionPlanStatus,
} from "@/components/confirmation";
import { UnifiedLot } from "@/types/lot";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { trackPurchase } from "@/lib/analytics/gtag";
import { purchasePromo } from "@/lib/analytics/purchase-value";
import { isPurchasePending, takePurchaseToTrack } from "@/lib/analytics/purchase-once";
import { confirmationErrorScreen, fetchStatusFor, type ConfirmationFetchStatus } from "@/lib/confirmation/fetch-status";
import { convertTo12Hour } from "@/lib/utils/time";
import { captureBookingError } from "@/lib/sentry";
import {
  guestProofHeaders,
  rememberConfirmationEmail,
  storeArrivalSecrets,
  stripSecretsFromAddressBar,
} from "@/lib/confirmation/guest-email";
import type { AtLotEstimateView } from "@/lib/direct/reservation-view";
import type { CostBreakdownResult, FallbackDue } from "@/lib/booking/cost-breakdown";
import type { CardSummary } from "@/lib/booking/confirmation-payment";
import type { PaymentFallback } from "@/components/confirmation/booking-details";

interface ConfirmationPageProps {
  params: Promise<{ id: string }>;
}

/** Fields both sources of GET /api/reservations/[id] return. */
interface ReservationDataBase {
  id: number | string;
  reservationNumber: string;
  /** Both API paths emit only these two (cancelled/refunded rows → "cancelled"). */
  status: "confirmed" | "cancelled";
  /** ResLab: pre-discount total incl. due-at-lot. Direct: pre-discount online total. */
  grandTotal: number;
  /** What was charged online: grandTotal − dueAtLocation (− promo discount on a direct booking). */
  dueNow: number;
  dueAtLocation: number;
  /**
   * The promo discount the booking got (bookings.discount_amount) and its code
   * — for the GA4 purchase event (promo plan D3). null when the API couldn't
   * read the booking row (ResLab path); absent on responses from before D3.
   */
  promoDiscount?: number | null;
  promoCode?: string | null;
  /**
   * The Payment summary, built and checked server-side (plan 2026-10-12).
   * The ONLY source of the money this page shows.
   */
  costBreakdown: CostBreakdownResult;
  /** The fallback's card side as Stripe reports it — never grandTotal, never a row-computed "charged". */
  cardPayment: CardSummary;
  /** What the fallback may say is due at the location / lot — never a guessed 0. */
  fallbackDue: FallbackDue;
  protectionPlan: string | null;
  protectionPlanPrice: number;
  pgSyncStatus: "pending" | "synced" | "skipped_missing_data" | null;
  pgIdentifier: string | null;
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
    /** Absent when the API couldn't read a day count (e.g. an hourly rate line). */
    numberOfDays?: number;
    numberOfSpots: number;
  }>;
  location: {
    /** ResLab location id (number), or the direct lot's CMS id (string). */
    id: number | string;
    name: string;
    address: string;
    city: string;
    state: string;
    zipCode: string;
    phone: string;
    /** ResLab sends strings; a direct booking sends numbers from its snapshot. */
    latitude: string | number;
    longitude: string | number;
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

/** A ResLab booking (`inventorySource` absent on responses from before it was added). */
interface ReslabReservationData extends ReservationDataBase {
  inventorySource?: "reslab";
  /** `bookings.airport_code` (e.g. "JFK"); null on rows from before it was derived. */
  airportCode?: string | null;
}

/** A Triply-owned lot (no ResLab record) — built from the booking row + lot snapshot. */
interface DirectReservationData extends ReservationDataBase {
  inventorySource: "direct";
  /** The lot's airport (from the booking's lot snapshot). */
  airportCode: string;
  /**
   * The oversized-vehicle surcharge PAID AT THE LOT. A separate display
   * value — never part of grandTotal / dueNow / dueAtLocation.
   */
  atLotEstimate: AtLotEstimateView | null;
}

type ReservationData = ReslabReservationData | DirectReservationData;

function ConfirmationContent({ confirmationId }: { confirmationId: string }) {
  const searchParams = useSearchParams();
  const supabase = createClient();

  const lotId = searchParams.get("lot");
  const checkInParam = searchParams.get("checkin");
  const checkOutParam = searchParams.get("checkout");
  const serviceFeeParam = searchParams.get("serviceFee");
  const emailParam = searchParams.get("email");
  const bookingKeyParam = searchParams.get("booking_key");
  // An emailed link's ?email= and ?booking_key=: kept from the first render,
  // because the effect below strips them from the address bar (GA4, Clarity
  // and Sentry record page URLs — see lib/confirmation/guest-email.ts).
  const arrivalEmailRef = useRef(emailParam);
  const arrivalKeyRef = useRef(bookingKeyParam);

  const [reservation, setReservation] = useState<ReservationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchStatus, setFetchStatus] = useState<ConfirmationFetchStatus | null>(null);
  // The email a guest typed on the "Open Your Confirmation Link" screen (a
  // copied, shared or bookmarked link has no email in it). A new object per
  // submit, so re-trying the same address fetches again.
  const [typedEmail, setTypedEmail] = useState<{ email: string } | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [showAccountPrompt, setShowAccountPrompt] = useState(true);
  const hasFiredPurchase = useRef(false);

  // The API reports "cancelled" from ResLab's own flag (ResLab bookings) or the
  // booking row (direct). A cancelled booking keeps its record on this page but
  // loses everything that only makes sense for a live reservation: the QR code,
  // calendar, directions, protection status and the purchase event.
  const isCancelled = reservation?.status === "cancelled";

  // Track the purchase once per booking: only on the load checkout sent the
  // customer to (takePurchaseToTrack), never on a revisit from the email link,
  // My Reservations or a refresh — those had double-counted 23% of purchases.
  // Never for a cancelled booking. The mark is only used up when gtag exists,
  // so a page that loads before the GA stub keeps it for a refresh.
  useEffect(() => {
    if (reservation?.location && reservation.status !== "cancelled" && !hasFiredPurchase.current) {
      hasFiredPurchase.current = true;
      if (typeof window.gtag !== "function" || !takePurchaseToTrack(confirmationId)) return;
      // Airport: from the booking row (ResLab) or the lot snapshot (direct) —
      // never the `lot` param, whose "reslab-N" / "direct-N" prefix GA4 used
      // to record as the airport (fix from Vin's PR #72). A direct lot id keeps
      // the "direct-" prefix so it can't collide with a ResLab location id.
      const isDirect = reservation.inventorySource === "direct";
      // The total before the code (both kinds of lot report `grandTotal` that
      // way), the discount and the code's family (promo plan D3).
      const promo = purchasePromo(reservation);
      trackPurchase({
        confirmationNumber: confirmationId,
        lotId: isDirect
          ? `direct-${reservation.location.id}`
          : String(reservation.location.id),
        lotName: reservation.location.name,
        grandTotal: promo.grossTotal,
        promoDiscount: promo.discount,
        coupon: promo.coupon,
        serviceFee: serviceFeeParam ? parseFloat(serviceFeeParam) : undefined,
        protectionPlanPrice: reservation.protectionPlanPrice || undefined,
        airportCode: reservation.airportCode || undefined,
      });
    }
  }, [reservation, confirmationId, serviceFeeParam]);

  // Check if user is logged in
  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
    };
    getUser();
  }, [supabase.auth]);

  // Emailed link arrival: remember the address and the booking key for
  // reloads, then take each out of the URL. Only once it is stored — if
  // storage is blocked the URL keeps it (a reload still works) and the
  // layout's guards keep it out of Clarity, GA4's page_view and Sentry.
  useEffect(() => {
    stripSecretsFromAddressBar(
      storeArrivalSecrets(confirmationId, { email: arrivalEmailRef.current, bookingKey: arrivalKeyRef.current })
    );
  }, [confirmationId]);

  // Fetch reservation data from API. A guest (not signed in) proves ownership
  // with the booking key from the emailed link (x-booking-key) or the checkout
  // email (x-booking-email) — headers, never the URL — via
  // /api/reservations/[id]. Both go when both are known: the key decides, the
  // email is the fallback. Refetches when the guest types an email on the
  // "Open Your Confirmation Link" screen.
  useEffect(() => {
    let active = true;
    const fetchReservation = async () => {
      try {
        const headers = guestProofHeaders(confirmationId, {
          typedEmail: typedEmail?.email ?? null,
          arrivalEmail: arrivalEmailRef.current,
          arrivalKey: arrivalKeyRef.current,
        });
        const response = await fetch(`/api/reservations/${confirmationId}`, { headers });
        if (!active) return;
        if (response.ok) {
          const data = await response.json();
          if (!active) return;
          // A typed email that opened the booking is kept for reloads.
          if (typedEmail) rememberConfirmationEmail(confirmationId, typedEmail.email);
          setReservation(data.reservation);
          setFetchStatus("ok");
        } else {
          const status = fetchStatusFor(response.status);
          setFetchStatus(status);
          if (status === "too-many-tries") {
            // The email path's try limit. Expected for a guesser; worth seeing
            // only when it hits a customer who has just paid here (their
            // hand-off should have carried the booking key).
            if (isPurchasePending(confirmationId)) {
              captureBookingError(
                new Error(`Confirmation ${confirmationId}: too many tries right after checkout`),
                { step: "confirmation", confirmationNumber: confirmationId, fingerprint: ["confirmation-429-after-checkout"], level: "warning" }
              );
            }
          } else if (status === "unavailable" || status === "error") {
            captureBookingError(
              new Error(`Confirmation ${confirmationId} fetch failed with status ${response.status}`),
              { step: "confirmation", confirmationNumber: confirmationId }
            );
          }
        }
      } catch (err) {
        if (!active) return;
        setFetchStatus("error");
        const wrapped = err instanceof Error
          ? new Error(`Confirmation ${confirmationId}: ${err.message}`)
          : new Error(`Confirmation ${confirmationId}: ${String(err)}`);
        captureBookingError(wrapped, { step: "confirmation" });
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchReservation();
    return () => {
      active = false;
    };
  }, [confirmationId, typedEmail]);

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

      // Build UnifiedLot from reservation data. Source-aware: a direct lot has
      // no ResLab location id; its id is "direct-<CMS id>" (the same id the
      // checkout put in ?lot=) and its coordinates arrive as numbers.
      const isDirect = reservation.inventorySource === "direct";
      const identity: Pick<UnifiedLot, "id" | "source" | "sourceId" | "reslabLocationId" | "airportCode"> = isDirect
        ? {
            id: `direct-${reservation.location.id}`,
            source: "direct",
            sourceId: String(reservation.location.id),
            airportCode: reservation.airportCode,
          }
        : {
            id: `reslab-${reservation.location.id}`,
            source: "reslab",
            sourceId: String(reservation.location.id),
            reslabLocationId: Number(reservation.location.id),
          };
      return {
        ...identity,
        name: reservation.location.name,
        slug: reservation.location.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        address: reservation.location.address,
        city: reservation.location.city,
        state: reservation.location.state,
        zipCode: reservation.location.zipCode,
        latitude: isDirect
          ? Number(reservation.location.latitude)
          : parseFloat(String(reservation.location.latitude)),
        longitude: isDirect
          ? Number(reservation.location.longitude)
          : parseFloat(String(reservation.location.longitude)),
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

  // Duration from the reservation; null when the API couldn't read a day
  // count (the Duration row is then hidden, never a guessed "1 day"). Money
  // comes ONLY from the API's costBreakdown / cardPayment — the page never
  // invents a total.
  const days = reservation?.items[0]?.numberOfDays ?? null;

  // The plain fallback's figures when the breakdown was refused — both decided
  // server-side (a missing or doubted due amount is "untrusted", never 0).
  const paymentFallback: PaymentFallback | null = reservation
    ? {
        card: reservation.cardPayment,
        due: reservation.fallbackDue,
        dueContext:
          reservation.inventorySource === "direct"
            ? { source: "direct", estimate: reservation.atLotEstimate }
            : { source: "reslab" },
      }
    : null;

  // Get customer and vehicle info
  const customerName = reservation
    ? `${reservation.customer.firstName} ${reservation.customer.lastName}`
    : "Customer";
  // Never a placeholder: an unknown address hides "Confirmation sent to" (and the
  // account prompt) rather than stating an address we never emailed.
  const customerEmail = reservation?.customer.email ?? "";
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
    const screen = confirmationErrorScreen(fetchStatus, !!user);
    const { headline, message } = screen;
    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar forceSolid />
        <main className="pt-20">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
            <AlertCircle size={48} className="mx-auto text-amber-500 mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-4">{headline}</h1>
            <p className="text-gray-600 mb-8">{message}</p>
            {screen.showNumber && (
              <div className="mb-8">
                <p className="text-sm text-gray-500 mb-4">
                  Confirmation number: <span className="font-mono font-semibold text-gray-900">{confirmationId}</span>
                </p>
                {screen.showSignIn && (
                  <Link
                    href={`/auth/login?next=${encodeURIComponent(`/confirmation/${confirmationId}`)}`}
                    className="text-brand-orange font-semibold hover:underline"
                  >
                    Sign in
                  </Link>
                )}
              </div>
            )}
            {screen.showEmailBox && (
              // A copied, shared or bookmarked link has no email in it; the
              // email typed here is the same proof the emailed link carries.
              // Guests only: the API checks a signed-in visitor by account.
              <form
                className="max-w-sm mx-auto mb-8 text-left"
                data-clarity-mask="true"
                onSubmit={(e) => {
                  e.preventDefault();
                  const email = emailInput.trim();
                  if (!email) return;
                  setLoading(true);
                  setTypedEmail({ email });
                }}
              >
                <label htmlFor="booking-email" className="block text-sm font-medium text-gray-700 mb-1">
                  Or enter the email you booked with
                </label>
                <div className="flex gap-2">
                  <input
                    id="booking-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    className="flex-1 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-orange"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 bg-brand-orange text-white font-bold rounded-lg hover:bg-orange-600 transition-colors"
                  >
                    View booking
                  </button>
                </div>
                {typedEmail && (
                  <p className="mt-2 text-sm text-red-600">
                    That email doesn&apos;t match this booking. Use the email you booked with, or the link in your confirmation email.
                  </p>
                )}
              </form>
            )}
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
  // location, or sessionStorage was empty on a re-visit) — or no reservation
  // at all (a lot from sessionStorage alone has no booking money to show) —
  // fall back to the generic not-found screen rather than rendering placeholders.
  if (!lot || !reservation || !paymentFallback) {
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
            cancelled={isCancelled}
          />

          {/* Main Content Grid (one centred column for a cancelled booking:
              the right column only holds live-reservation items) */}
          <div
            className={
              isCancelled
                ? "grid grid-cols-1 gap-8 max-w-2xl mx-auto"
                : "grid grid-cols-1 lg:grid-cols-2 gap-8"
            }
          >
            {/* Left Column — masked in Clarity recordings: it shows the
                guest's name, contact and vehicle details (see /privacy §6). */}
            <div className="space-y-6" data-clarity-mask="true">
              <BookingDetails
                lot={lot}
                checkIn={checkIn}
                checkOut={checkOut}
                checkInTime={checkInTime}
                checkOutTime={checkOutTime}
                days={days}
                customerName={customerName}
                customerEmail={customerEmail}
                customerPhone={customerPhone}
                vehicleInfo={vehicleInfo}
                costBreakdown={reservation.costBreakdown}
                fallback={paymentFallback}
                cancelled={isCancelled}
              />

              {!isCancelled && reservation.protectionPlan && (
                <ProtectionPlanStatus
                  planName={reservation.protectionPlan}
                  pgSyncStatus={reservation.pgSyncStatus}
                  pgIdentifier={reservation.pgIdentifier}
                />
              )}

              {!isCancelled && (
                <AddToCalendar
                  lot={lot}
                  checkIn={checkIn}
                  checkOut={checkOut}
                  checkInTime={checkInTime}
                  checkOutTime={checkOutTime}
                  confirmationId={confirmationId}
                />
              )}
            </div>

            {/* Right Column */}
            {!isCancelled && (
              <div className="space-y-6">
                <QRCodeSection
                  confirmationId={confirmationId}
                  lotName={lot.name}
                />

                <WhatsNext lot={lot} checkIn={checkIn} checkInTime={checkInTime} />
              </div>
            )}
          </div>

          {/* Create Account Prompt (for guests only) */}
          {!isCancelled && !user && showAccountPrompt && customerEmail && (
            // Masked in Clarity: shows the guest's email (and takes a password).
            <div className="mt-8" data-clarity-mask="true">
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
          {!isCancelled && (
            <p className="text-center text-sm text-gray-500 mt-8">
              We recommend saving or printing this confirmation for your records.
            </p>
          )}
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
