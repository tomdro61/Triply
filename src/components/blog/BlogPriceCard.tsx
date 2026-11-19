'use client'

import Link from 'next/link'
import { Bus, MapPin, ArrowRight } from 'lucide-react'
import { money } from '@/lib/fx/usd-label'
import { trackBlogCtaClick } from '@/lib/analytics/gtag'
import type { BlogPriceSnapshot } from '@/lib/blog/price-snapshot'

/**
 * Mid-article live price card (price arm only): the 3 cheapest lots we sell
 * at the post's airport with their per-day price, linking to each lot page,
 * plus a link to every lot on /search. Replaces the "Ready to Book…" block on
 * the price arm; the control arm keeps that block.
 *
 * Prices are "from" figures at the airport page's default window (tomorrow +
 * 7 days) and never reach a booking: the lot page and /search re-price for
 * the reader's own dates. The note under the heading says so.
 */
export function BlogPriceCard({ snapshot }: { snapshot: BlogPriceSnapshot }) {
  const { airportCode, airportSlug, lots, totalLots } = snapshot

  return (
    <aside className="my-10 rounded-2xl border border-coral/20 bg-coral/5 px-5 py-6">
      {/* A <p> styled as a heading so the injected block never adds an H2 to the outline. */}
      <p className="text-xl font-heading font-bold text-navy">
        {airportCode} parking from {money(snapshot.fromPrice, snapshot.fromUsdLabel)}/day
      </p>
      <p className="text-xs text-gray-500 mt-1 mb-4">
        {/* minPrice is the daily rate before taxes and the service fee (reslab/search.ts), so no "fees included" claim. */}
        Daily rates for a 7-day stay starting tomorrow. Taxes and fees show at checkout, and prices change by date.
      </p>

      <ul className="divide-y divide-coral/10 rounded-xl bg-white border border-gray-200">
        {lots.map((lot, i) => (
          <li key={`${lot.slug}-${i}`}>
            <Link
              href={`/${airportSlug}/airport-parking/${lot.slug}`}
              onClick={() => trackBlogCtaClick({ airportCode, placement: 'price-card-lot' })}
              className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
            >
              <span className="min-w-0">
                <span className="block font-semibold text-gray-900 text-sm truncate">{lot.name}</span>
                <span className="flex items-center gap-3 mt-0.5 text-xs text-gray-500">
                  {lot.distance !== null && (
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {lot.distance.toFixed(1)} mi
                    </span>
                  )}
                  {/* Only a positive claim: missing shuttle data does not mean no shuttle (same as lot-grid). */}
                  {lot.shuttle && (
                    <span className="flex items-center gap-1">
                      <Bus className="w-3 h-3" />
                      Shuttle
                    </span>
                  )}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="text-lg font-bold text-coral">{money(lot.price, lot.usdLabel)}</span>
                <span className="text-xs text-gray-400">/day</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <Link
        href={`/search?airport=${airportCode}`}
        onClick={() => trackBlogCtaClick({ airportCode, placement: 'price-card-all' })}
        className="mt-4 inline-flex items-center gap-1 bg-coral text-white px-6 py-3 rounded-lg font-semibold hover:bg-coral/90 transition-colors"
      >
        Compare {totalLots > lots.length ? `all ${totalLots} ` : ''}{airportCode} lots for your dates
        <ArrowRight className="w-4 h-4" />
      </Link>
    </aside>
  )
}
