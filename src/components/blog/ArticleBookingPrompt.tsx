import { getSellableAirportCode } from '@/config/airports'
import { SearchWidget } from '@/components/airport/search-widget'

interface ArticleBookingPromptProps {
  airportCode?: string | null
}

/**
 * Booking prompt at the top of an article: the same airport search widget the
 * airport landing pages use, with this article's airport already selected, so
 * a reader only has to pick dates.
 *
 * Every article gets the widget. When the post carries an airportCode we can
 * actually sell, that airport is preselected; otherwise the airport box starts
 * empty and the reader picks one (the widget's search button stays disabled
 * until they do).
 */
export function ArticleBookingPrompt({ airportCode }: ArticleBookingPromptProps) {
  const preselected = getSellableAirportCode(airportCode)

  return (
    <section className="bg-gray-50 border-b">
      <div className="container mx-auto px-4 py-6">
        <div className="max-w-3xl mx-auto">
          <p className="text-sm font-semibold text-navy mb-2">
            Book {preselected ? `${preselected} ` : ''}airport parking — pick your dates
          </p>
          <SearchWidget airportCode={preselected} variant="compact" />
        </div>
      </div>
    </section>
  )
}
