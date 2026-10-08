"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * True while `query` matches. Always false on the server and during
 * hydration, so markup that depends on it must look right when it is false.
 *
 * `subscribe` is memoised on `query`: useSyncExternalStore re-subscribes
 * whenever the subscribe function's identity changes, and the search page
 * re-renders on every card/marker hover — an inline arrow here would tear
 * down and re-add the matchMedia listener on each of those renders.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query]
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  );
}
