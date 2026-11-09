"use client";

import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";
import { getContentGroup, getAirportFromPath } from "@/lib/analytics/content-groups";
import { hasAnalyticsOptOut } from "@/lib/cookies/consent";
import { revokeAnalyticsConsent } from "@/lib/analytics/gtag";
import { revokeClarityConsent } from "@/lib/analytics/clarity";
import { reloadToDropMinty } from "@/lib/analytics/minty";

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

  // Minty pilot: a client-side move into checkout / confirmation / account
  // pages would keep its widget running there; reload so it is dropped. A
  // layout effect, so it runs (and mutes GA) before the new page's effects.
  const mintyPath = useRef<string | null>(pathname);
  useLayoutEffect(() => {
    if (pathname === mintyPath.current) return;
    mintyPath.current = pathname;
    reloadToDropMinty(pathname);
  }, [pathname]);

  useEffect(() => {
    if (pathname === previousPathname.current) return;
    previousPathname.current = pathname;


    const contentGroup = getContentGroup(pathname);

    // Extract airport code from path, or fall back to ?airport= query param
    let airportCode = getAirportFromPath(pathname);
    if (!airportCode && pathname === "/search") {
      airportCode = new URLSearchParams(window.location.search).get("airport");
    }

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
