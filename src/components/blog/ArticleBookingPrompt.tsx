import { getAirportByCode } from '@/config/airports'
import { SearchWidget } from '@/components/airport/search-widget'

interface ArticleBookingPromptProps {
  airportCode?: string | null
}

/**
 * Booking prompt at the top of an article: the same airport search widget the
 * airport landing pages use, with this article's airport already selected, so
 * a reader only has to pick dates. Renders nothing when the post has no
 * airportCode or the code isn't an airport we actually sell.
 */
export function ArticleBookingPrompt({ airportCode }: ArticleBookingPromptProps) {
  if (!airportCode) return null

  const airport = getAirportByCode(airportCode)
  if (!airport || !airport.enabled) return null

  return (
    <section className="bg-gray-50 border-b">
      <div className="container mx-auto px-4 py-6">
        <div className="max-w-3xl mx-auto">
          <p className="text-sm font-semibold text-navy mb-2">
            Book {airport.code} parking — pick your dates
          </p>
          <SearchWidget airportCode={airport.code} variant="compact" />
        </div>
      </div>
    </section>
  )
}
