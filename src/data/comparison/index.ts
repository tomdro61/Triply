/**
 * Competitor comparison snapshots for the
 * /{slug}/spothero-vs-airportparkingreservations-vs-triply pages.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * Triply's own numbers on these pages come from LIVE ResLab data
 * (fetchAirportPageData). Competitor numbers cannot: SpotHero's lot list is
 * client-rendered and APR's rate table is a page they update by hand. So
 * competitor figures are a hand-verified snapshot, and every snapshot carries
 * the date it was read.
 *
 * ── The rule this file enforces ───────────────────────────────────────────
 * A stale price in a "cheapest platform" claim is a promise that breaks at
 * checkout. Past SNAPSHOT_MAX_AGE_DAYS (@/lib/comparison/build) the page
 * still renders, but competitor prices and the price-based verdict are
 * suppressed rather than silently asserted.
 *
 * ── Refresh procedure ─────────────────────────────────────────────────────
 * 1. Open the competitor URL below in a real browser (SpotHero needs JS).
 * 2. Read the "from" rate and the lot rate table.
 * 3. Update `lots`, `fromRate`, and bump `verifiedOn` to today.
 * Do NOT bump `verifiedOn` without re-reading the page.
 */

export type CompetitorKey = "spothero" | "apr";

export interface CompetitorLot {
  /** Lot name exactly as the competitor prints it. */
  lot: string;
  /** Competitor's own parking-type label, e.g. "Self Uncovered". */
  parkingType?: string;
  distanceMiles?: number;
  /** Advertised daily rate, before that platform's taxes and fees. */
  dailyRate: number;
  /**
   * Substring used to match this lot against a LIVE Triply lot name for the
   * same-lot table. Omit when Triply doesn't carry the property, or when we
   * haven't confirmed it is the same property — the row is then dropped
   * rather than guessed at.
   */
  triplyLotNameContains?: string;
}

export interface CompetitorSnapshot {
  key: CompetitorKey;
  name: string;
  shortName: string;
  url: string;
  /** Lowest daily rate the platform advertises on its own airport page. */
  fromRate: number | null;
  fromRateLot?: string;
  /** False when the platform's headline "from" lot has no free terminal shuttle. */
  fromRateHasShuttle: boolean;
  /** Lots visible on the competitor's airport page, cheapest first. */
  lots: CompetitorLot[];
  /** Null when the page doesn't state a count we can trust. */
  lotCount: number | null;
  strengths: string[];
  weaknesses: string[];
  /** ISO date these numbers were read off the competitor's live page. */
  verifiedOn: string;
}

export interface OnAirportRate {
  label: string;
  dailyRate: number;
}

export interface AirportComparison {
  code: string;
  /** Must match the Airport.slug in @/config/airports. */
  slug: string;
  /**
   * "live"  → prerendered, sitemapped, linked from the airport hub.
   * "draft" → 404s and stays out of the sitemap. Use this when the live
   *            numbers don't support publishing the page yet.
   */
  status: "live" | "draft";
  /** One line explaining a "draft" status. Shown to nobody; read by humans. */
  draftReason?: string;
  onAirport: OnAirportRate[];
  competitors: CompetitorSnapshot[];
  /**
   * The headline claim. Written to be TRUE at the verified rates — never
   * "we are cheapest" unless we actually are. If live rates stop matching
   * `cheapestPlatform`, the page falls back to a neutral lede on its own.
   */
  verdict: {
    /** Answer-first sentence. `{triplyFrom}` is substituted with the live rate. */
    lede: string;
    /** Who wins on raw advertised price at the verified rates. */
    cheapestPlatform: "triply" | "apr" | "spothero";
    bestFor: Record<CompetitorKey | "triply", string>;
  };
  /** Extra comparison-intent FAQs beyond the generated price ones. */
  faqs: { question: string; answer: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshots — competitor sides read 2026-10-22.
// APR: the "Our Daily Rate" table on its airport page (APR stamps it
// "Prices last updated: October 1, 2026"). SpotHero: the "from" rate in its
// airport page title; its lot list only renders for a searched date.
//
// All three are DRAFT: at these rates Triply is not the cheapest platform at
// any of the three airports (Triply live floors on 2026-10-22: BOS $12.55,
// DEN $6.70, PHX $4.19). Flip one to "live" only when we're ready to publish
// a page that says so — the lede degrades to a neutral one automatically.
// ─────────────────────────────────────────────────────────────────────────────

const BOS: AirportComparison = {
  code: "BOS",
  slug: "boston-bos",
  status: "draft",
  draftReason:
    "APR advertises BOS from $5.00 and SpotHero from $4.50 vs Triply's $12.55; Broadway Motor Service is $7.99 on APR vs $12.55 on Triply.",
  onAirport: [
    { label: "Logan Economy Garage", dailyRate: 37 },
    { label: "Central Parking / Terminal B Garage", dailyRate: 46 },
  ],
  competitors: [
    {
      key: "apr",
      name: "AirportParkingReservations",
      shortName: "APR",
      url: "https://www.airportparkingreservations.com/bos/airport-parking",
      fromRate: 5.0,
      fromRateLot: "Airport Parking Boston 1 (self uncovered, 7.5 mi)",
      fromRateHasShuttle: true,
      lotCount: 5,
      lots: [
        { lot: "Airport Parking Boston 1", parkingType: "Self Uncovered", distanceMiles: 7.5, dailyRate: 5.0 },
        { lot: "Broadway Motor Service", parkingType: "Self Uncovered", distanceMiles: 3.2, dailyRate: 7.99, triplyLotNameContains: "Broadway Motor Service" },
        // Triply's "Se-lect Airport Valet Parking - Boston Logan" is likely the
        // same property — not matched until confirmed.
        { lot: "Select Parking at Hampton Inn", parkingType: "Valet Uncovered", distanceMiles: 2.5, dailyRate: 16.89 },
        { lot: "Park N Boston", parkingType: "Self Uncovered", distanceMiles: 2.8, dailyRate: 16.99, triplyLotNameContains: "Park N Boston" },
        { lot: "Comfort Inn & Suites Boston Logan Airport", parkingType: "Self Uncovered", distanceMiles: 4.1, dailyRate: 18.0 },
      ],
      strengths: ["Lowest advertised rate at BOS", "Long-running brand with deep review counts"],
      weaknesses: ["Cheapest lot is 7.5 miles out", "Rate table is updated by hand, not live"],
      verifiedOn: "2026-10-22",
    },
    {
      key: "spothero",
      name: "SpotHero",
      shortName: "SpotHero",
      url: "https://spothero.com/airport/boston/bos-parking",
      fromRate: 4.5,
      fromRateLot: "headline rate on its BOS page",
      fromRateHasShuttle: true,
      lotCount: null,
      lots: [],
      strengths: ["Best mobile app", "Covered downtown and Cambridge garages"],
      weaknesses: [
        "Top-rated lots on its BOS page run $15–$34/day",
        "Lot list only appears after you enter dates",
      ],
      verifiedOn: "2026-10-22",
    },
  ],
  verdict: {
    lede:
      "For off-airport parking at Boston Logan (BOS), SpotHero and AirportParkingReservations advertise lower headline rates than Triply Pro, which lists lots from {triplyFrom}/day. All three beat Logan's on-airport garages ($37/day economy, up to $46 central).",
    cheapestPlatform: "spothero",
    bestFor: {
      triply: "All-in price shown up front, with every lot's shuttle details before you book",
      apr: "Lowest advertised rate and the widest lot table",
      spothero: "App-first booking and covered downtown garages",
    },
  },
  faqs: [
    {
      question: "Do all three platforms include a free airport shuttle at Boston Logan?",
      answer:
        "Most off-airport Logan lots on Triply Pro, AirportParkingReservations, and SpotHero include a free shuttle to the terminals in the parking price. SpotHero also lists downtown garages that don't need a shuttle. Shuttle frequency and hours are shown on each lot before you book.",
    },
  ],
};

const DEN: AirportComparison = {
  code: "DEN",
  slug: "denver-den",
  status: "draft",
  draftReason:
    "SpotHero advertises DEN from $4.08 and APR from $6.59 vs Triply's $6.70; Aloft Gateway Park is $6.59 on APR vs $8.29 on Triply.",
  onAirport: [
    { label: "DEN Economy Lot", dailyRate: 17 },
    { label: "East / West Garages", dailyRate: 28 },
  ],
  competitors: [
    {
      key: "apr",
      name: "AirportParkingReservations",
      shortName: "APR",
      url: "https://www.airportparkingreservations.com/den/airport-parking",
      fromRate: 6.59,
      fromRateLot: "Aloft Denver Airport at Gateway Park (self uncovered, 11.7 mi)",
      fromRateHasShuttle: true,
      lotCount: 4,
      lots: [
        { lot: "Aloft Denver Airport at Gateway Park", parkingType: "Self Uncovered", distanceMiles: 11.7, dailyRate: 6.59, triplyLotNameContains: "Aloft Denver Airport" },
        { lot: "Fine Airport Parking DIA", parkingType: "Self Covered", distanceMiles: 3.7, dailyRate: 9.49 },
        { lot: "Park 2 Jet Denver", parkingType: "Self Indoor", distanceMiles: 6.0, dailyRate: 9.99, triplyLotNameContains: "Park2Jet" },
        { lot: "WallyPark Airport Parking DEN", parkingType: "Self Uncovered", distanceMiles: 2.5, dailyRate: 10.0 },
      ],
      strengths: ["Carries Fine and WallyPark, two of the most-reviewed DEN lots", "Closest-in cheap lots (2.5–3.7 mi)"],
      weaknesses: ["Its cheapest lot is 11.7 miles out", "Only four DEN lots in its rate table"],
      verifiedOn: "2026-10-22",
    },
    {
      key: "spothero",
      name: "SpotHero",
      shortName: "SpotHero",
      url: "https://spothero.com/airport/denver/den-parking",
      fromRate: 4.08,
      fromRateLot: "headline rate on its DEN page",
      fromRateHasShuttle: true,
      lotCount: null,
      lots: [],
      strengths: ["Best mobile app", "Lowest advertised headline rate at DEN"],
      weaknesses: ["Lot list only appears after you enter dates"],
      verifiedOn: "2026-10-22",
    },
  ],
  verdict: {
    lede:
      // {under9} / {lotCount} are substituted from LIVE inventory — never
      // hardcode a lot count here, it goes stale the first time supply moves.
      "For off-airport parking at Denver International (DEN), SpotHero advertises the lowest headline rate. Triply Pro lists {lotCount} Denver lots from {triplyFrom}/day, {under9} of them under $9/day, close to AirportParkingReservations' $6.59. All three undercut DEN's on-airport Economy Lot at $17/day.",
    cheapestPlatform: "spothero",
    bestFor: {
      triply: "The most sub-$9 hotel lots, with the all-in price shown up front",
      apr: "Fine and WallyPark — two of the most-reviewed Denver lots",
      spothero: "App-first booking and the lowest headline rate",
    },
  },
  faqs: [
    {
      question: "Is off-airport parking cheaper than DEN's Economy Lot?",
      answer:
        "Yes, substantially. Denver's on-airport Economy Lot is $17/day and its garages run up to $28/day. Off-airport lots on all three platforms start well under half that, with a free shuttle to the Jeppesen Terminal. The trade-off is a 5–12 mile shuttle ride instead of a walk from the garage.",
    },
    {
      question: "Do the cheap Denver off-airport lots include a shuttle?",
      answer:
        "Most do. Off-airport Denver lots on Triply Pro, AirportParkingReservations, and SpotHero generally include a free shuttle to the Jeppesen Terminal, though hotel shuttles can stop overnight. Shuttle frequency, hours, and distance are listed on each lot before you book.",
    },
  ],
};

const PHX: AirportComparison = {
  code: "PHX",
  slug: "phoenix-phx",
  status: "draft",
  draftReason:
    "APR advertises PHX from $3.50 and SpotHero from $4 vs Triply's $4.19; Triply loses Howard Johnson ($5.25 vs $3.50), PreFlight and Sky Harbor Airport Parking on the same lot.",
  onAirport: [
    { label: "East Economy (uncovered)", dailyRate: 16 },
    { label: "East Economy Garages A & B", dailyRate: 19 },
    { label: "Terminal 3/4 Garages", dailyRate: 33 },
  ],
  competitors: [
    {
      key: "apr",
      name: "AirportParkingReservations",
      shortName: "APR",
      url: "https://www.airportparkingreservations.com/phx/airport-parking",
      fromRate: 3.5,
      fromRateLot: "Howard Johnson Airport Downtown (self uncovered)",
      fromRateHasShuttle: false,
      lotCount: 6,
      lots: [
        { lot: "Howard Johnson Airport Downtown", parkingType: "Self Uncovered", distanceMiles: 3.5, dailyRate: 3.5, triplyLotNameContains: "Howard Johnson" },
        { lot: "Radisson Hotel Phoenix Airport", parkingType: "Self Uncovered", distanceMiles: 1.7, dailyRate: 7.5 },
        { lot: "Crowne Plaza Phoenix Airport Hotel", parkingType: "Premium Self Indoor", distanceMiles: 1.7, dailyRate: 9.0, triplyLotNameContains: "Crowne Plaza" },
        { lot: "PreFlight Airport Parking (PHX)", parkingType: "Self Covered", distanceMiles: 1.7, dailyRate: 9.49, triplyLotNameContains: "PreFlight Airport Parking" },
        { lot: "The Parking Spot South PHX", parkingType: "Self Covered", distanceMiles: 2.4, dailyRate: 11.25 },
        { lot: "Sky Harbor Airport Parking", parkingType: "Self Covered", distanceMiles: 1.7, dailyRate: 13.95, triplyLotNameContains: "Sky Harbor Airport Parking" },
      ],
      strengths: ["Lowest advertised rate at PHX", "Carries The Parking Spot South"],
      weaknesses: ["Cheapest lot has no shuttle (the hotel's is suspended)", "Rate table is updated by hand, not live"],
      verifiedOn: "2026-10-22",
    },
    {
      key: "spothero",
      name: "SpotHero",
      shortName: "SpotHero",
      url: "https://spothero.com/airport/phoenix/phx-parking",
      fromRate: 4.0,
      fromRateLot: "headline rate on its PHX page",
      fromRateHasShuttle: true,
      lotCount: null,
      lots: [],
      strengths: ["Best mobile app"],
      weaknesses: ["Lot list only appears after you enter dates"],
      verifiedOn: "2026-10-22",
    },
  ],
  verdict: {
    lede:
      "For off-airport parking at Phoenix Sky Harbor (PHX), AirportParkingReservations has the lowest headline rate — $3.50/day at Howard Johnson, an uncovered hotel lot with no shuttle. Triply Pro lists lots from {triplyFrom}/day and SpotHero advertises from $4/day. All three beat Sky Harbor's on-airport rates of $16–$33/day.",
    cheapestPlatform: "apr",
    bestFor: {
      triply: "Transparent all-in pricing and shuttle hours shown for every lot",
      apr: "Lowest headline rate",
      spothero: "App-first booking",
    },
  },
  faqs: [
    {
      question: "Do Phoenix off-airport lots include a free shuttle to the terminal?",
      answer:
        "Most do, but not the very cheapest. The lowest-priced PHX hotel lots (Howard Johnson, La Quinta Tempe) have no shuttle, and some hotel shuttles stop overnight. Check the shuttle hours on the lot before booking a rock-bottom rate on an early or late flight.",
    },
  ],
};

export const comparisons: AirportComparison[] = [BOS, DEN, PHX];

export function getComparisonBySlug(slug: string): AirportComparison | null {
  return comparisons.find((c) => c.slug === slug) ?? null;
}

/** Only these get prerendered, sitemapped, and linked from the airport hub. */
export const liveComparisons = comparisons.filter((c) => c.status === "live");
