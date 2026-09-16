import Link from 'next/link'

interface ArticleCtaProps {
  airportCode?: string | null
}

function ctaHref(code: string) {
  return code ? `/search?airport=${code}` : '/'
}

function normalise(airportCode?: string | null) {
  return airportCode ? airportCode.toUpperCase() : ''
}

/**
 * The full "Ready to Book…" block. Same copy as the old page-bottom section,
 * restyled as a card so it can sit inside the article body (~30% down) rather
 * than below the fold at the very end.
 *
 * The "save up to 70%" figure is deliberately left generic: the real number is
 * airport-specific (55–89%) and is not available in the post data this page
 * loads, so nothing is hardcoded per airport here.
 */
export function ArticleCta({ airportCode }: ArticleCtaProps) {
  const code = normalise(airportCode)

  return (
    <aside className="not-prose my-10 rounded-2xl border border-coral/20 bg-coral/5 px-6 py-8 text-center">
      <h2 className="text-2xl font-heading font-bold text-navy mb-4">
        Ready to Book Your {code ? `${code} ` : ''}Airport Parking?
      </h2>
      <p className="text-gray-600 mb-6 max-w-xl mx-auto">
        Compare prices from top-rated parking lots and save up to 70% on your next trip.
      </p>
      <Link
        href={ctaHref(code)}
        className="inline-block bg-coral text-white px-8 py-3 rounded-lg font-semibold hover:bg-coral/90 transition-colors"
      >
        Find Parking Now
      </Link>
    </aside>
  )
}

/** One-line version for the end of the page, once the full block is mid-article. */
export function ArticleCtaInline({ airportCode }: ArticleCtaProps) {
  const code = normalise(airportCode)

  return (
    <p className="text-gray-600">
      Ready to book your {code ? `${code} ` : ''}airport parking?{' '}
      <Link
        href={ctaHref(code)}
        className="font-semibold text-coral hover:underline"
      >
        Find Parking Now
      </Link>
    </p>
  )
}
