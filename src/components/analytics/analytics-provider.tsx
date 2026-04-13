"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { getContentGroup, getAirportFromPath } from "@/lib/analytics/content-groups";
import { hasAnalyticsOptOut } from "@/lib/cookies/consent";
import { revokeAnalyticsConsent } from "@/lib/analytics/gtag";
import { revokeClarityConsent } from "@/lib/analytics/clarity";

/**
 * AnalyticsProvider
 *
 * Tracks page views with content group classification on every route change.
 * Add this component to your root layout (inside the body).
 */
export function AnalyticsProvider() {
  const pathname = usePathname();
  const previousPathname = useRef<string | null>(pathname);

  // On mount, revoke consent if user previously opted out
  useEffect(() => {
    if (hasAnalyticsOptOut()) {
      revokeAnalyticsConsent();
      revokeClarityConsent();
    }
  }, []);

  useEffect(() => {
    if (pathname === previousPathname.current) return;
    previousPathname.current = pathname;

    const contentGroup = getContentGroup(pathname);

    // Extract airport code from path, or fall back to ?airport= query param
    const airportCode =
      getAirportFromPath(pathname) ||
      new URLSearchParams(window.location.search).get("airport") ||
      undefined;

    if (window.gtag) {
      window.gtag("set", "user_properties", {
        content_group: contentGroup,
      });

      window.gtag("event", "page_view", {
        page_path: pathname,
        content_group: contentGroup,
        ...(airportCode && { airport_code: airportCode }),
      });
    }
  }, [pathname]);

  return null;
}
