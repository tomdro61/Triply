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
