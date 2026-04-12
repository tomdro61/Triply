"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { getContentGroup } from "@/lib/analytics/content-groups";

/**
 * AnalyticsProvider
 *
 * Tracks page views with content group classification on every route change.
 * Add this component to your root layout (inside the body).
 */
export function AnalyticsProvider() {
  const pathname = usePathname();
  const previousPathname = useRef<string | null>(pathname);

  useEffect(() => {
    if (pathname === previousPathname.current) return;
    previousPathname.current = pathname;

    const contentGroup = getContentGroup(pathname);

    if (window.gtag) {
      window.gtag("set", "user_properties", {
        content_group: contentGroup,
      });

      window.gtag("event", "page_view", {
        page_path: pathname,
        content_group: contentGroup,
      });
    }
  }, [pathname]);

  return null;
}
