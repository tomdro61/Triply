import type { Airport } from "@/config/airports";
import type { UnifiedLot } from "@/types/lot";
import { calculateDistance } from "@/lib/utils/geo";
import type { DirectLot } from "./store";
import { computeDirectQuote, directDays } from "./pricing";

/**
 * DirectLot → UnifiedLot, the shape every search card, lot page and checkout
 * component already renders (plan §2.2 adapter).
 *
 * Two things this must never do:
 * - carry partner-facing data to the browser: `partnerSharePercent` and
 *   `notificationEmails` are read here and deliberately not copied (pinned by
 *   adapter.test.ts, which serialises the result and greps for them);
 * - guess a price: `pricing` is present only when the searched window parses
 *   and prices through the same `computeDirectQuote` checkout will charge
 *   (Phase 3), so search, lot page and checkout cannot disagree.
 */

export interface DirectQuoteWindow {
  /** "YYYY-MM-DD HH:MM[:SS]" airport-local wall clock, as searchParking builds it. */
  fromDate: string;
  toDate: string;
}

export function directLotToUnified(lot: DirectLot, airport: Airport, window: DirectQuoteWindow | null): UnifiedLot {
  const photos: UnifiedLot["photos"] = [];
  if (lot.featuredImage) photos.push({ id: `${lot.id}-featured`, url: lot.featuredImage.url, alt: lot.featuredImage.alt ?? lot.name });
  lot.galleryUrls.forEach((url, i) => {
    if (url !== lot.featuredImage?.url) photos.push({ id: `${lot.id}-gallery-${i}`, url, alt: lot.name });
  });

  const days = window ? directDays(window.fromDate, window.toDate) : null;
  const quote = days?.ok ? computeDirectQuote({ rateCents: lot.rateCents, days: days.days, taxRatePercent: lot.taxRatePercent }) : null;

  const instructions = lot.bookingInstructions;
  const specialConditions = [instructions.importantNotes, instructions.whenYouArrive].filter((s): s is string => !!s).join("\n\n");

  return {
    id: lot.id,
    source: "direct",
    sourceId: String(lot.payloadId),
    airportCode: lot.airportCode,

    name: lot.name,
    slug: lot.slug,
    address: lot.address.street,
    city: lot.address.city,
    state: lot.address.state,
    zipCode: lot.address.zip,
    country: "United States",
    latitude: lot.coordinates.lat,
    longitude: lot.coordinates.lng,

    description: lot.descriptionShort ?? undefined,
    directions: instructions.gettingToAirport ?? undefined,
    specialConditions: specialConditions || undefined,
    phone: lot.shuttlePhone ?? undefined,

    shuttleInfo: lot.shuttleDetails
      ? {
          summary: lot.distanceToTerminalMinutes ? `Shuttle to the terminal (about ${lot.distanceToTerminalMinutes} min)` : "Shuttle to the terminal",
          details: lot.shuttleDetails,
        }
      : undefined,

    amenities: lot.amenities.map((a) => ({ id: a.id, name: a.name, displayName: a.name, icon: a.icon ?? undefined })),
    photos: photos.length > 0 ? photos : [{ id: "placeholder", url: "/placeholder-parking.jpg", alt: lot.name }],

    rating: undefined,
    reviewCount: undefined,

    distanceFromAirport: calculateDistance(airport.latitude, airport.longitude, lot.coordinates.lat, lot.coordinates.lng),

    // The daily rate needs no window, so it is always present (a lot page
    // reached with a reversed/unparseable window shows the real rate, not
    // "$0.00"). The TOTALS exist only when the window priced; a consumer that
    // needs a total (search's grandTotal filter, the widget's API-pricing
    // branch) sees them absent and falls back, never a zero.
    pricing: {
      minPrice: lot.rateCents / 100,
      currency: "$",
      currencyCode: "USD",
      parkingTypes: [],
      taxValue: lot.taxRatePercent,
      taxType: "net",
      ...(quote
        ? {
            grandTotal: quote.grandTotalCents / 100,
            subtotal: quote.subtotalCents / 100,
            feesTotal: 0,
            taxTotal: quote.taxTotalCents / 100,
            numberOfDays: days && days.ok ? days.days : undefined,
          }
        : {}),
    },

    // No live inventory feed for direct lots (plan D2): the lot sells until
    // it is deactivated in the CMS.
    availability: "available",

    minimumBookingDays: lot.minStayDays > 1 ? lot.minStayDays : undefined,
    hoursBeforeReservation: lot.minLeadHours > 0 ? lot.minLeadHours : undefined,
    dailyOrHourly: "daily",

    // Paid in full online (plan D4).
    dueAtLocation: false,
    dueAtLocationAmount: 0,

    extraFields: [],
    // Left undefined on purpose: the booking widget then shows Triply's own
    // "Free cancellation up to 24h before", which is the policy direct bookings
    // get (eligibility.ts, Phase 5).
    cancellationPolicies: undefined,
  };
}
