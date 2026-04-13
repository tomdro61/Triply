import { airportsByCode, getAirportBySlug } from "@/config/airports";

// Set of known codes (lowercased) for fast lookups in blog URL scanning
const knownCodesLower = new Set(
  Object.keys(airportsByCode)
    .filter((c) => !c.startsWith("TEST"))
    .map((c) => c.toLowerCase())
);

/**
 * Extract airport code from a URL pathname.
 *
 * Patterns matched:
 *   /{slug}/airport-parking       → slug lookup (e.g. new-york-jfk → JFK)
 *   /{slug}/airport-parking/{lot} → same
 *   /blog/*                       → scan path segments for a known 3-letter code
 *   /search                       → needs query param (handled by caller)
 */
export function getAirportFromPath(pathname: string): string | null {
  // Airport landing pages and lot detail pages: /{slug}/airport-parking[/{lot}]
  const airportPageMatch = pathname.match(/^\/([^/]+)\/airport-parking/);
  if (airportPageMatch) {
    const airport = getAirportBySlug(airportPageMatch[1]);
    if (airport) return airport.code;
  }

  // Blog pages: scan path segments for a 3-letter airport code
  if (pathname.startsWith("/blog/")) {
    const segments = pathname.toLowerCase().split(/[/-]/);
    for (const segment of segments) {
      if (segment.length === 3 && knownCodesLower.has(segment)) {
        return segment.toUpperCase();
      }
    }
  }

  return null;
}

/**
 * Content Group Classification
 *
 * Maps URL patterns to content groups for GA4 reporting.
 * Used by the AnalyticsProvider to tag every page view.
 */
export function getContentGroup(pathname: string): string {
  if (pathname === "/") return "Homepage";
  if (/^\/[^/]+\/airport-parking$/.test(pathname)) return "Airport Landing Page";
  if (pathname === "/airport-parking") return "Airport Directory";
  if (/^\/[^/]+\/airport-parking\/.+/.test(pathname)) return "Lot Detail";
  if (pathname === "/blog") return "Blog Index";
  if (pathname.startsWith("/blog/airport/")) return "Blog Airport Hub";
  if (pathname.startsWith("/blog/category/")) return "Blog Category Hub";
  if (pathname.startsWith("/blog/")) return "Blog Post";
  if (pathname === "/search") return "Search Results";
  if (pathname === "/checkout") return "Checkout";
  if (pathname.startsWith("/confirmation")) return "Confirmation";
  if (pathname === "/help") return "Help/FAQ";
  if (pathname === "/contact") return "Contact";
  if (pathname === "/about") return "About";
  if (pathname === "/terms" || pathname === "/privacy") return "Legal";
  if (pathname === "/account" || pathname === "/reservations") return "Account";
  if (pathname.startsWith("/auth")) return "Auth";
  return "Other";
}
