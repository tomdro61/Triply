import { NextResponse } from "next/server";

export async function GET() {
  const content = `# Triply
> Airport parking, simplified.

## About
Triply (triplypro.com) is an airport parking aggregator that helps travelers compare and book affordable parking near major airports. We partner with verified parking facilities to offer competitive rates, free cancellation, and shuttle service to terminals.

## Services
- Compare parking lots near airports by price, distance, rating, and amenities
- Book online with instant confirmation
- Free cancellation on most reservations
- Shuttle service included with most lots
- Guest checkout available (no account required)
- Secure payments via Stripe (credit cards, Apple Pay, Google Pay)

## Airports Covered
- John F. Kennedy International Airport (JFK) - New York, NY
- LaGuardia Airport (LGA) - New York, NY

## Key Facts
- Brand name: Triply
- Tagline: "Your Trip Simplified"
- Website: https://triplypro.com
- Support email: support@triplypro.com
- Business model: Parking aggregator (we partner with third-party parking facilities)
- Pricing: All-inclusive (taxes and fees included in displayed price)

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
