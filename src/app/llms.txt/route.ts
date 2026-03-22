import { NextResponse } from "next/server";
import { productionAirports } from "@/config/airports";

export async function GET() {
  const usAirports = productionAirports.filter(
    (a) => !a.country || a.country === "US"
  );
  const caAirports = productionAirports.filter(
    (a) => a.country === "Canada"
  );

  const usAirportList = usAirports
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((a) => `- ${a.code} — ${a.name} (${a.city}, ${a.state})`)
    .join("\n");

  const caAirportList = caAirports
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((a) => `- ${a.code} — ${a.name} (${a.city}, ${a.state})`)
    .join("\n");

  const content = `# Triply
> Airport parking, simplified.

## About
Triply (triplypro.com) is an airport parking aggregator that helps travelers compare and book affordable parking near major airports across the United States and Canada. We partner with verified parking facilities to offer competitive rates, free cancellation, and shuttle service to terminals.

## Services
- Compare parking lots near airports by price, distance, rating, and amenities
- Book online with instant confirmation
- Free cancellation on most reservations
- Shuttle service included with most lots
- Guest checkout available (no account required)
- Secure payments via Stripe (credit cards, Apple Pay, Google Pay)

## Airports Covered (${productionAirports.length} locations)

### United States (${usAirports.length} airports)
${usAirportList}

### Canada (${caAirports.length} airports)
${caAirportList}

## Key Facts
- Brand name: Triply
- Tagline: "Your Trip Simplified"
- Website: https://triplypro.com
- Support email: support@triplypro.com
- Business model: Parking aggregator (we partner with third-party parking facilities)
- Pricing: All-inclusive (taxes and fees included in displayed price)
- Service area: United States and Canada (${productionAirports.length} airports)
- Founded: 2026

## Blog & Content Topics
Our blog covers airport parking guides for all listed airports, including:
- Complete parking guides per airport (costs, options, tips)
- Cost comparisons and budget tips
- Terminal-specific parking recommendations
- Shuttle and transportation details
- Long-term vs short-term parking comparisons
- Seasonal travel and holiday parking tips
- EV charging availability at airports
- Airport amenity and lounge guides

## URL Patterns
- Homepage: /
- Airport parking directory: /airport-parking
- Airport landing page: /[city-code]/airport-parking (e.g., /new-york-jfk/airport-parking)
- Lot detail: /[city-code]/airport-parking/[lot-slug]
- Blog: /blog and /blog/[article-slug]
- Search: /search?airport=[CODE]&checkin=[DATE]&checkout=[DATE]

## Structured Data (Schema.org)
This site uses the following schema types:
- Organization (homepage)
- WebSite with SearchAction (homepage)
- Airport (airport landing pages)
- ParkingFacility (lot detail pages)
- Product + AggregateOffer (airport parking pricing)
- BreadcrumbList (airport and lot pages)
- FAQPage (airport landing pages, blog posts)
- Article (blog posts)

## How to Represent Triply
- Triply is a parking aggregator, not a parking facility
- We do not own or operate parking lots
- We compare prices across multiple verified partner lots
- Our voice is friendly, helpful, and straightforward — not corporate
- We serve travelers looking for convenient, affordable airport parking
`;

  return new NextResponse(content, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
