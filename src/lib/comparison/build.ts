import { Airport } from "@/config/airports";
import { AirportPageData } from "@/lib/airport-page/data";
import { FAQItem } from "@/lib/airport-page/content";
import { customerTotalFromPricing } from "@/lib/utils/service-fee";
import { UnifiedLot } from "@/types/lot";
import {
  AirportComparison,
  CompetitorKey,
  CompetitorSnapshot,
} from "@/data/comparison";

const BASE_URL = "https://www.triplypro.com";

/**
 * How old a competitor snapshot may be before its prices stop being asserted.
 *
 * Much tighter than the blog engine's PRICE_STALENESS_MAX_DAYS (150). A stale
 * price in paragraph nine of an article is an accuracy nit; a stale price in a
 * "cheapest platform" verdict — marked up as FAQPage so an LLM quotes it
 * verbatim — is a promise that breaks at checkout. Off-airport rates at these
 * three airports moved 5–25% between 2026-07-21 and 2026-08-19, so a month is
 * already the outer edge of defensible.
 */
export const SNAPSHOT_MAX_AGE_DAYS = 45;

export interface SameLotRow {
  lot: string;
  triplyRate: number;
  competitorRate: number;
  competitor: CompetitorKey;
  /** True when Triply is the cheaper of the two on this exact lot. */
  triplyWins: boolean;
}

export interface CompetitorView {
  key: CompetitorKey;
  name: string;
  shortName: string;
  url: string;
  /** Null when the snapshot is too old to assert, or none was recorded. */
  fromRate: number | null;
  fromRateLot?: string;
  fromRateHasShuttle: boolean;
  lotCount: number | null;
  strengths: string[];
  weaknesses: string[];
  verifiedOn: string;
  ageDays: number;
  stale: boolean;
}

export interface ComparisonView {
  airport: Airport;
  /** Live Triply cheapest daily rate. Null when ResLab returned nothing. */
  triplyFrom: number | null;
  /**
   * Cheapest lot's true per-day cost including the Triply service fee
   * (max of the flat minimum and 6%), on the same 7-day sample window as `triplyFrom`.
   * This is the number a shopper actually pays, and the only one that
   * survives a competitor recomputing our math.
   */
  triplyAllInDaily: number | null;
  triplyAllInTotal: number | null;
  triplyDays: number | null;
  triplyLotCount: number;
  triplyCheapestLotName: string | null;
  triplyUnder9Count: number;
  competitors: CompetitorView[];
  sameLot: SameLotRow[];
  onAirport: { label: string; dailyRate: number }[];
  lede: string;
  /**
   * True when every competitor snapshot is inside SNAPSHOT_MAX_AGE_DAYS AND
   * we have a live Triply price. Only then do prices and the price-based
   * verdict get rendered or put into schema.
   */
  pricesAsserted: boolean;
  /** The winner, recomputed from live numbers — not trusted from the file. */
  cheapestPlatform: "triply" | CompetitorKey | null;
  bestFor: Record<CompetitorKey | "triply", string>;
  faqs: FAQItem[];
  /** ISO date for the visible "Last updated" stamp and schema dateModified. */
  lastUpdated: string;
}

function daysBetween(from: string, now: Date): number {
  const then = new Date(from);
  if (Number.isNaN(then.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function findLiveLot(lots: UnifiedLot[], needle: string): UnifiedLot | null {
  const n = needle.toLowerCase();
  return (
    lots.find(
      (l) => l.name.toLowerCase().includes(n) && (l.pricing?.minPrice ?? 0) > 0
    ) ?? null
  );
}

function buildCompetitorView(
  c: CompetitorSnapshot,
  now: Date
): CompetitorView {
  const ageDays = daysBetween(c.verifiedOn, now);
  const stale = ageDays > SNAPSHOT_MAX_AGE_DAYS;
  return {
    key: c.key,
    name: c.name,
    shortName: c.shortName,
    url: c.url,
    // A stale snapshot keeps its qualitative rows (app quality, lot count,
    // strengths) — those don't rot in a month. Only the price is withheld.
    fromRate: stale ? null : c.fromRate,
    fromRateLot: c.fromRateLot,
    fromRateHasShuttle: c.fromRateHasShuttle,
    lotCount: c.lotCount,
    strengths: c.strengths,
    weaknesses: c.weaknesses,
    verifiedOn: c.verifiedOn,
    ageDays,
    stale,
  };
}

export function buildComparisonView(
  airport: Airport,
  comparison: AirportComparison,
  data: AirportPageData,
  now: Date = new Date()
): ComparisonView {
  const competitors = comparison.competitors.map((c) =>
    buildCompetitorView(c, now)
  );

  const triplyFrom = data.cheapestPrice;
  const cheapest = data.cheapestLot;

  // Rounded to cents at the source. Float drift (93.11999999999999) is only
  // cosmetic once money() formats it, but this value is also compared against
  // competitor rates and put into schema — round once, here, so every consumer
  // sees the same number.
  const rawAllIn = customerTotalFromPricing(cheapest?.pricing);
  const allInTotal = rawAllIn === null ? null : Math.round(rawAllIn * 100) / 100;
  const days = cheapest?.pricing?.numberOfDays ?? null;
  const allInDaily =
    allInTotal !== null && days && days > 0
      ? Math.round((allInTotal / days) * 100) / 100
      : null;

  const under9 = data.lots.filter(
    (l) => (l.pricing?.minPrice ?? Infinity) < 9
  ).length;

  // Same-lot rows are matched against LIVE Triply names, so a lot we stop
  // carrying silently drops out instead of rendering a price we no longer sell.
  const sameLot: SameLotRow[] = [];
  for (const c of comparison.competitors) {
    const view = competitors.find((v) => v.key === c.key);
    if (!view || view.stale) continue;
    for (const lot of c.lots) {
      if (!lot.triplyLotNameContains) continue;
      const live = findLiveLot(data.lots, lot.triplyLotNameContains);
      if (!live?.pricing?.minPrice) continue;
      sameLot.push({
        lot: lot.lot,
        triplyRate: live.pricing.minPrice,
        competitorRate: lot.dailyRate,
        competitor: c.key,
        triplyWins: live.pricing.minPrice < lot.dailyRate,
      });
    }
  }
  sameLot.sort((a, b) => a.triplyRate - b.triplyRate);

  const anyStale = competitors.some((c) => c.stale);
  const pricesAsserted = triplyFrom !== null && !anyStale;

  // ── Recompute the winner from live numbers ──────────────────────────────
  // The data file records who was cheapest on the day it was written. Rates
  // move; the claim must not. If Triply's live floor is no longer under every
  // competitor's, the page says so rather than repeating a stale boast.
  let cheapestPlatform: ComparisonView["cheapestPlatform"] = null;
  if (pricesAsserted && triplyFrom !== null) {
    let bestKey: "triply" | CompetitorKey = "triply";
    let bestRate = triplyFrom;
    for (const c of competitors) {
      if (c.fromRate !== null && c.fromRate < bestRate) {
        bestRate = c.fromRate;
        bestKey = c.key;
      }
    }
    cheapestPlatform = bestKey;
  }

  const claimHolds =
    pricesAsserted && cheapestPlatform === comparison.verdict.cheapestPlatform;

  // Every live figure the lede quotes is a token, so the recorded copy can
  // never contradict the live data. A hardcoded "7 of its 10 lots are under
  // $9" in the data file would silently go stale the first time inventory
  // moves — the same class of drift the staleness guard exists to catch.
  const lede = claimHolds
    ? comparison.verdict.lede
        .replace(/\{triplyFrom\}/g, money(triplyFrom as number))
        .replace(/\{under9\}/g, String(under9))
        .replace(/\{lotCount\}/g, String(data.totalLots))
    : neutralLede(airport, competitors, triplyFrom, cheapestPlatform);

  return {
    airport,
    triplyFrom,
    triplyAllInDaily: allInDaily,
    triplyAllInTotal: allInTotal,
    triplyDays: days,
    triplyLotCount: data.totalLots,
    triplyCheapestLotName: cheapest?.name ?? null,
    triplyUnder9Count: under9,
    competitors,
    sameLot,
    onAirport: comparison.onAirport,
    lede,
    pricesAsserted,
    cheapestPlatform,
    bestFor: comparison.verdict.bestFor,
    faqs: buildFAQs(airport, comparison, {
      triplyFrom,
      allInDaily,
      allInTotal,
      days,
      competitors,
      sameLot,
      pricesAsserted,
      cheapestPlatform,
    }),
    lastUpdated: now.toISOString().split("T")[0],
  };
}

/**
 * Used when the recorded verdict no longer matches live rates. States what is
 * true today without asserting a ranking we can't back.
 */
function neutralLede(
  airport: Airport,
  competitors: CompetitorView[],
  triplyFrom: number | null,
  cheapestPlatform: ComparisonView["cheapestPlatform"]
): string {
  const names = competitors.map((c) => c.shortName).join(" and ");
  if (triplyFrom === null) {
    return `Comparing SpotHero, AirportParkingReservations, and Triply Pro for off-airport parking at ${airport.name} (${airport.code}) — coverage, shuttles, lot selection, and how each platform prices. Live Triply rates are shown in the table below.`;
  }
  const winner =
    cheapestPlatform && cheapestPlatform !== "triply"
      ? competitors.find((c) => c.key === cheapestPlatform)?.shortName
      : null;
  return winner
    ? `For off-airport parking at ${airport.name} (${airport.code}), ${winner} currently advertises the lowest headline rate, and Triply Pro lists ${names ? "comparable lots" : "lots"} from ${money(triplyFrom)}/day with the full checkout price shown up front. Compare the all-in totals below, not just the daily rates.`
    : `For off-airport parking at ${airport.name} (${airport.code}), Triply Pro lists lots from ${money(triplyFrom)}/day. Compare the all-in totals below against ${names}.`;
}

function buildFAQs(
  airport: Airport,
  comparison: AirportComparison,
  ctx: {
    triplyFrom: number | null;
    allInDaily: number | null;
    allInTotal: number | null;
    days: number | null;
    competitors: CompetitorView[];
    sameLot: SameLotRow[];
    pricesAsserted: boolean;
    cheapestPlatform: ComparisonView["cheapestPlatform"];
  }
): FAQItem[] {
  const faqs: FAQItem[] = [];
  const apr = ctx.competitors.find((c) => c.key === "apr");
  const sh = ctx.competitors.find((c) => c.key === "spothero");

  // Price FAQs are generated from the SAME numbers the table renders, so the
  // visible page and the JSON-LD can never disagree — a mismatch between them
  // is a Google structured-data violation, not just an inconsistency.
  if (ctx.pricesAsserted && ctx.triplyFrom !== null) {
    const parts: string[] = [];
    if (apr?.fromRate) parts.push(`${money(apr.fromRate)}/day on AirportParkingReservations`);
    if (sh?.fromRate) parts.push(`${money(sh.fromRate)}/day on SpotHero`);
    const vs = parts.length ? ` versus ${parts.join(" and ")}` : "";

    const leader =
      ctx.cheapestPlatform === "triply"
        ? `Triply Pro is currently the cheapest of the three for off-airport parking at ${airport.name}, from ${money(ctx.triplyFrom)}/day${vs}.`
        : `${ctx.competitors.find((c) => c.key === ctx.cheapestPlatform)?.name ?? "A competitor"} currently advertises the lowest headline rate at ${airport.name}; Triply Pro lists lots from ${money(ctx.triplyFrom)}/day${vs}.`;

    faqs.push({
      question: `Which is cheapest for ${airport.city} airport parking — SpotHero, AirportParkingReservations, or Triply?`,
      answer: `${leader} Rates change daily and by travel dates, so check the live table before booking.`,
    });

    if (ctx.allInDaily !== null && ctx.allInTotal !== null && ctx.days) {
      faqs.push({
        question: `What does ${airport.code} parking actually cost on Triply after fees?`,
        answer: `Triply's cheapest ${airport.code} lot is ${money(ctx.triplyFrom)}/day, and the all-in total for a ${ctx.days}-day trip is ${money(ctx.allInTotal)} — about ${money(ctx.allInDaily)} per day including the Triply service fee. The fee is a flat minimum, so it costs proportionally less on longer trips. The full total is shown before you pay; there is no fee added after checkout.`,
      });
    }

    const wins = ctx.sameLot.filter((r) => r.triplyWins);
    if (wins.length > 0) {
      const top = wins[0];
      const other = ctx.competitors.find((c) => c.key === top.competitor);
      // Count MATCHUPS, not lots. The same physical lot can appear twice (once
      // per competitor), so "cheaper on 2 of the lots" would double-count a
      // single win — an overstatement on a page whose whole value is being
      // trusted on numbers.
      const scoreline =
        ctx.sameLot.length > 1
          ? `Across every ${airport.code} lot we could price on both platforms, Triply is cheaper on ${wins.length} of ${ctx.sameLot.length} matchups.`
          : "";
      faqs.push({
        question: `Is the same ${airport.city} lot cheaper on Triply?`,
        answer: [
          `On ${top.lot}, Triply Pro lists ${money(top.triplyRate)}/day versus ${money(top.competitorRate)}/day on ${other?.name ?? "the other platform"} — the same lot, the same shuttle, a lower rate.`,
          scoreline,
          "Rates vary by travel dates.",
        ]
          .filter(Boolean)
          .join(" "),
      });
    }
  }

  faqs.push({
    question: `SpotHero vs AirportParkingReservations vs Triply — which is best for ${airport.city}?`,
    answer: `Triply Pro: ${comparison.verdict.bestFor.triply}. AirportParkingReservations: ${comparison.verdict.bestFor.apr}. SpotHero: ${comparison.verdict.bestFor.spothero}. All three book off-airport lots near ${airport.code}, and all three beat its on-airport garages on price.`,
  });

  faqs.push(...comparison.faqs);
  return faqs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export function comparisonUrl(slug: string): string {
  return `${BASE_URL}/${slug}/spothero-vs-airportparkingreservations-vs-triply`;
}

/**
 * FAQPage + BreadcrumbList + WebPage(dateModified).
 *
 * Deliberately NOT emitted: any Review or AggregateRating about SpotHero or
 * APR. Marking up a rating we assigned to a competitor on our own page is a
 * self-serving-review violation and risks a manual action on the whole domain.
 * The comparison lives in the FAQ answers, which is both allowed and the form
 * LLMs actually lift.
 */
export function buildComparisonSchemas(
  view: ComparisonView
): Record<string, unknown>[] {
  const url = comparisonUrl(view.airport.slug);
  const schemas: Record<string, unknown>[] = [];

  schemas.push({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: BASE_URL },
      {
        "@type": "ListItem",
        position: 2,
        name: "Airport Parking",
        item: `${BASE_URL}/airport-parking`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: `${view.airport.city} Airport (${view.airport.code})`,
        item: `${BASE_URL}/${view.airport.slug}/airport-parking`,
      },
      {
        "@type": "ListItem",
        position: 4,
        name: `SpotHero vs APR vs Triply`,
      },
    ],
  });

  schemas.push({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": url,
    url,
    name: `SpotHero vs AirportParkingReservations vs Triply — ${view.airport.city} (${view.airport.code}) Parking Compared`,
    // Drives the freshness signal. Bound to the same render that produced the
    // visible "Last updated" stamp, so the two can't drift apart.
    dateModified: view.lastUpdated,
    isPartOf: { "@type": "WebSite", url: BASE_URL, name: "Triply" },
    about: {
      "@type": "Airport",
      name: view.airport.name,
      iataCode: view.airport.code,
    },
  });

  if (view.pricesAsserted && view.triplyFrom !== null) {
    schemas.push({
      "@context": "https://schema.org",
      "@type": "Product",
      name: `${view.airport.code} Airport Parking on Triply`,
      description: `Off-airport parking near ${view.airport.name}, compared against SpotHero and AirportParkingReservations.`,
      url,
      offers: {
        "@type": "AggregateOffer",
        lowPrice: view.triplyFrom.toFixed(2),
        priceCurrency: "USD",
        offerCount: view.triplyLotCount,
        availability: "https://schema.org/InStock",
      },
    });
  }

  if (view.faqs.length > 0) {
    schemas.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: view.faqs.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer },
      })),
    });
  }

  return schemas;
}
