import { Airport } from "@/config/airports";
import { AirportPageData } from "./data";
import { anyUsdLabelled, money } from "@/lib/fx/usd-label";
import { lotRunsShuttle } from "./shuttle";

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
  } = data;

  // "US$" when the page lists a lot whose price we convert from Canadian dollars.
  const usd = anyUsdLabelled(data.lots);

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

  const one = totalLots === 1;
  const shuttles = shuttleLotCount(data);
  const minText = priceRange ? money(priceRange.min, usd, 0) : "";
  const maxText = priceRange ? money(priceRange.max, usd, 0) : "";
  // When the whole-dollar range collapses (one lot, or rates like $7.75 and
  // $8.05), say the cheapest rate to the cent: "from $8.40/day", never
  // "$8–$8/day", and never a rounded "$8" next to "$8.40/day" further down.
  const priceText = !priceRange
    ? ""
    : minText === maxText
      ? `, with rates from ${money(priceRange.min, usd)}/day`
      : `, with daily rates ranging from ${minText}–${maxText}/day`;

  const sections: SEOSection[] = [
    {
      heading: `Parking at ${name}`,
      body: `Triply partners with ${totalLots} off-airport parking ${one ? "facility" : "facilities"} near ${name} (${code})${priceText}. ${shuttleSentence(totalLots, shuttles)} Compare options with the airport's own garage rates and book online.`,
    },
    {
      heading: `Long-Term ${code} Parking`,
      body: cheapestLot
        ? `For extended trips, ${cheapestLot.name} ${one ? "is bookable" : "offers the lowest daily rate"} at ${money(cheapestLot.pricing?.minPrice ?? 0, usd)}/day${cheapestLot.distanceFromAirport ? `, located ${cheapestLot.distanceFromAirport.toFixed(1)} miles from the terminal` : ""}. Compare it with ${code}'s own long-term rates before you book.`
        : `Compare off-airport parking near ${code} with the airport's own long-term rates, and book ahead through Triply for your dates.`,
    },
    {
      heading: `Short-Term & Daily Parking`,
      body: closestLot
        ? `${closestLot.name} is ${one ? "" : "the closest option at "}${(closestLot.distanceFromAirport ?? 0).toFixed(1)} miles from ${code}, ideal for quick trips or same-day travel. Off-airport lots near ${city} are a convenient alternative to expensive terminal-adjacent garages.`
        : `Off-airport lots near ${city} offer a convenient, affordable alternative to terminal garages for short trips.`,
    },
    {
      heading: `Tips for Parking at ${name}`,
      body: [
        `• **Book ahead** — Rates are often lower when reserved in advance vs. drive-up pricing.`,
        shuttles > 0
          ? `• **Check shuttle hours** — Shuttle hours and frequency differ by lot; each lot's page lists them, so match them to your flight times.`
          : `• **Plan the ride to the terminal** — ${one ? "This lot lists" : "These lots list"} no shuttle right now, so plan on a rideshare or taxi to ${code}.`,
        one
          ? `• **Check the details** — The lot's page shows its live rate, how to check in and how to reach the terminal.`
          : `• **Compare options** — Use Triply to see all ${totalLots} ${code} parking lots side by side with real-time rates.`,
        `• **Allow extra time** — Plan to arrive 15–20 minutes earlier than you would for on-airport parking to account for the ride to the terminal.`,
      ].join("\n"),
    },
  ];

  return sections;
}

/** Lots whose shuttle summary (or, without one, amenities) lists a shuttle. */
function shuttleLotCount(data: AirportPageData): number {
  return data.lots.filter(lotRunsShuttle).length;
}

/** What the page may say about shuttles, from the lots it lists. */
function shuttleSentence(totalLots: number, shuttles: number): string {
  if (totalLots === 1) {
    return shuttles === 1
      ? "It runs a shuttle to and from the terminal."
      : "It lists no shuttle right now, so plan on a rideshare to the terminal.";
  }
  if (shuttles === totalLots) return "Every lot listed runs a shuttle to and from the terminal.";
  if (shuttles === 0) return "None of these lots lists a shuttle right now, so plan on a rideshare to the terminal.";
  return `${shuttles} of the ${totalLots} lots run a shuttle to the terminal; check each lot's shuttle hours before you book.`;
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

  const shuttles = shuttleLotCount(data);
  const minMi = distanceRange?.min.toFixed(1);
  const maxMi = distanceRange?.max.toFixed(1);

  return [
    {
      question: `What is the cheapest parking near ${code}?`,
      answer: cheapestLot
        ? `The most affordable option is ${cheapestLot.name} at ${money(cheapestPrice ?? 0, anyUsdLabelled(data.lots))}/day. Prices are based on a sample 7-day trip and may vary by dates.`
        : `Off-airport parking near ${code} offers competitive daily rates. Search on Triply to find the best price for your dates.`,
    },
    {
      question: `How far are parking lots from ${name}?`,
      answer: distanceRange
        ? `${totalLots === 1 ? `Off-airport parking near ${code} is ${minMi} miles from the terminal.` : minMi === maxMi ? `Off-airport parking lots near ${code} start ${minMi} miles from the terminal.` : `Off-airport parking lots near ${code} are between ${minMi} and ${maxMi} miles from the terminal.`} Each lot's page shows how to reach the terminal.`
        : `Each lot's page on Triply shows its distance from ${code} and how to reach the terminal.`,
    },
    {
      question: `Do ${code} parking lots offer shuttle service?`,
      answer:
        shuttles === 0
          ? `${totalLots === 1 ? "The lot we list near" : "The lots we list near"} ${code} ${totalLots === 1 ? "lists" : "list"} no shuttle right now, so plan on a rideshare or taxi to the terminal. Each lot's page has the latest details.`
          : `${shuttleSentence(totalLots, shuttles)} ${totalLots === 1 ? "The lot's page on Triply lists its shuttle hours." : "Shuttle hours and frequency differ by lot; each lot's page on Triply lists them."}`,
    },
    {
      question: `Can I cancel my ${code} parking reservation?`,
      answer: `Most parking reservations booked through Triply can be cancelled free of charge up to 24 hours before your scheduled check-in. Check the cancellation policy on each lot's detail page for specific terms.`,
    },
    {
      question: `How do I book ${code} airport parking?`,
      answer: `Search for ${code} parking on Triply, ${totalLots === 1 ? "check the available lot's price, distance and amenities" : `compare ${totalLots} available lots by price, distance, and amenities`}, then book online in minutes. You'll receive a confirmation email with a QR code — no printing needed.`,
    },
    {
      question: `When should I book ${code} airport parking?`,
      answer: `We recommend booking at least 1–2 weeks before your trip for the best rates. Prices tend to increase closer to your travel date, especially during holidays and peak travel seasons.`,
    },
  ];
}

/**
 * True when the page rendered from a successful search and has nothing to
 * sell — we list nothing near the airport, or every listed lot is sold out or
 * unavailable for the sampled week. Such pages get an honest meta description:
 * a search result promising "compare parking lots... book now" that lands on
 * an empty page wastes the click (13 ResLab lots across 11 airports sat
 * flagged sold_out from May–Oct 2026 while their pages stayed indexed). null
 * means the count is unknown — claim nothing, change nothing.
 */
export function isKnownEmpty(
  totalLots: number,
  locationsConsidered: number | null
): boolean {
  return totalLots === 0 && locationsConsidered !== null;
}

/** Meta description for a known-empty page. No prices, no lot counts. */
export function emptyMetaDescription(airportName: string, airportCode: string): string {
  return `No ${airportCode} parking lots are bookable on Triply right now. Search your dates near ${airportName} for the latest availability.`;
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
