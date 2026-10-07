import { Airport } from "@/config/airports";
import { AirportPageData } from "./data";

export interface SEOSection {
  heading: string;
  body: string;
}

export interface FAQItem {
  question: string;
  answer: string;
}

/**
 * Generate template-driven SEO content sections using real lot data.
 */
export function generateSEOContent(
  airport: Airport,
  data: AirportPageData
): SEOSection[] {
  const { code, name, city } = airport;
  const {
    totalLots,
    priceRange,
    cheapestLot,
    cheapestPrice,
    closestLot,
    hasShuttle,
  } = data;

  if (totalLots === 0) {
    return [
      {
        heading: `Parking at ${name}`,
        // Neutral on purpose: 0 lots can mean "we list none here" or "all
        // booked for the sampled week" (the page shows its own copy for each
        // and doesn't render this section at 0 lots today).
        body: `Search Triply for parking near ${name} (${code}) to see the lots and rates available for your dates near ${city}.`,
      },
    ];
  }

  const priceText = priceRange
    ? `$${priceRange.min.toFixed(0)}–$${priceRange.max.toFixed(0)}/day`
    : "";

  const sections: SEOSection[] = [
    {
      heading: `Parking at ${name}`,
      body: `Triply partners with ${totalLots} off-airport parking ${totalLots === 1 ? "facility" : "facilities"} near ${name} (${code})${priceText ? `, with daily rates ranging from ${priceText}` : ""}. ${hasShuttle ? "Most lots offer complimentary shuttle service to and from the terminal." : "Select lots offer shuttle service to the terminal."} Compare options, book online, and save compared to on-airport garage rates.`,
    },
    {
      heading: `Long-Term ${code} Parking`,
      body: cheapestLot
        ? `For extended trips, ${cheapestLot.name} offers the lowest daily rate at $${(cheapestLot.pricing?.minPrice ?? 0).toFixed(2)}/day${cheapestLot.distanceFromAirport ? `, located ${cheapestLot.distanceFromAirport.toFixed(1)} miles from the terminal` : ""}. Booking ahead through Triply typically saves 30–60% compared to on-airport long-term parking rates at ${code}.`
        : `Off-airport parking near ${code} typically saves 30–60% compared to on-airport long-term rates. Book ahead through Triply to lock in the best price for your trip.`,
    },
    {
      heading: `Short-Term & Daily Parking`,
      body: closestLot
        ? `${closestLot.name} is the closest option at ${(closestLot.distanceFromAirport ?? 0).toFixed(1)} miles from ${code}, ideal for quick trips or same-day travel. Off-airport lots near ${city} are a convenient alternative to expensive terminal-adjacent garages.`
        : `Off-airport lots near ${city} offer a convenient, affordable alternative to terminal garages for short trips.`,
    },
    {
      heading: `Tips for Parking at ${name}`,
      body: [
        `• **Book ahead** — Rates are often lower when reserved in advance vs. drive-up pricing.`,
        `• **Check shuttle schedules** — Most off-airport lots run shuttles every 5–15 minutes to ${code} terminals.`,
        `• **Compare options** — Use Triply to see all ${totalLots} ${code} parking lots side by side with real-time rates.`,
        `• **Allow extra time** — Plan to arrive 15–20 minutes earlier than you would for on-airport parking to account for the shuttle ride.`,
      ].join("\n"),
    },
  ];

  return sections;
}

/**
 * Generate airport-specific FAQ Q&As using real data.
 */
export function generateFAQs(
  airport: Airport,
  data: AirportPageData
): FAQItem[] {
  const { code, name } = airport;
  const {
    cheapestLot,
    cheapestPrice,
    distanceRange,
    hasShuttle,
    totalLots,
  } = data;

  if (totalLots === 0) {
    return [
      {
        question: `Is off-airport parking available near ${code}?`,
        answer: `Search Triply with your travel dates to see which parking options near ${name} are available.`,
      },
    ];
  }

  return [
    {
      question: `What is the cheapest parking near ${code}?`,
      answer: cheapestLot
        ? `The most affordable option is ${cheapestLot.name} at $${(cheapestPrice ?? 0).toFixed(2)}/day. Prices are based on a sample 7-day trip and may vary by dates.`
        : `Off-airport parking near ${code} offers competitive daily rates. Search on Triply to find the best price for your dates.`,
    },
    {
      question: `How far are parking lots from ${name}?`,
      answer: distanceRange
        ? `Off-airport parking lots near ${code} are between ${distanceRange.min.toFixed(1)} and ${distanceRange.max.toFixed(1)} miles from the terminal. Most facilities provide complimentary shuttle service.`
        : `Parking lots near ${code} are a short shuttle ride from the terminal.`,
    },
    {
      question: `Do ${code} parking lots offer shuttle service?`,
      answer: hasShuttle
        ? `Yes, most off-airport parking lots near ${code} provide free shuttle service to and from the terminal. Shuttles typically run every 5–15 minutes.`
        : `Many off-airport lots near ${code} offer shuttle service to the terminal. Check individual lot details on Triply for shuttle information.`,
    },
    {
      question: `Can I cancel my ${code} parking reservation?`,
      answer: `Most parking reservations booked through Triply can be cancelled free of charge up to 24 hours before your scheduled check-in. Check the cancellation policy on each lot's detail page for specific terms.`,
    },
    {
      question: `How do I book ${code} airport parking?`,
      answer: `Search for ${code} parking on Triply, compare ${totalLots} available lots by price, distance, and amenities, then book online in minutes. You'll receive a confirmation email with a QR code — no printing needed.`,
    },
    {
      question: `When should I book ${code} airport parking?`,
      answer: `We recommend booking at least 1–2 weeks before your trip for the best rates. Prices tend to increase closer to your travel date, especially during holidays and peak travel seasons.`,
    },
  ];
}

/**
 * Copy for an airport page with no bookable lots in its sampled week, keyed on
 * how many lots we list there (AirportPageData.locationsConsidered):
 * - 0: we list nothing near this airport → "coming soon".
 * - > 0: we serve it, but every lot was sold out or unavailable → say so; never
 *   "coming soon" for an airport we serve.
 * - null: unknown (the search failed during a build) → claim nothing.
 * No absolute dates in the copy: an ISR page can be served stale after a quiet
 * spell; the relative "next week" is bounded by the hourly revalidation.
 */
export function emptyStateCopy(
  airportName: string,
  locationsConsidered: number | null
): { heading: string; body: string } {
  if (locationsConsidered === 0) {
    return {
      heading: "Parking Options Coming Soon",
      body: `We're expanding our parking inventory near ${airportName}. Use the search above to check for the latest availability.`,
    };
  }
  if (locationsConsidered === null) {
    return {
      heading: `Find Parking Near ${airportName}`,
      body: "Use the search above to see available lots and prices for your dates.",
    };
  }
  return {
    heading: "No Online Availability for the Next Week",
    body: `Parking near ${airportName} is booked or unavailable for the next week. Use the search above to check your dates.`,
  };
}
