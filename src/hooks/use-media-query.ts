"use client";

import { useSyncExternalStore } from "react";

/**
 * True while `query` matches. Always false on the server and during
 * hydration, so markup that depends on it must look right when it is false.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}
