"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import Cookies from "js-cookie";
import {
  buildTouch,
  isNewTouch,
  isSkippedPath,
  pageAirport,
  parseStateCookie,
} from "@/lib/attribution/capture";
import { ATTR_STATE_COOKIE } from "@/lib/attribution/constants";

/**
 * AttributionCapture
 *
 * Observes each page view and, only when it is a NEW acquisition touch or the
 * airport in context changed, POSTs it to /api/attribution, which sets the
 * HttpOnly `triply_attr` cookie server-side. Reads only the small readable
 * sentinel cookie (`triply_attr_state`) to decide — it cannot read the payload.
 *
 * Mount inside <Suspense>: useSearchParams() is needed as the TRIGGER because
 * /search changes airport without changing the pathname, and without a
 * Suspense boundary the hook would force the whole (main) tree — including the
 * ISR airport pages — to render dynamically. The touch itself is built from
 * window.location so a transiently-empty hook value on first render can never
 * record a decorated landing as "direct".
 */

/** After a rejected/failed POST, stop re-posting for a while — otherwise every
 *  visitor behind a rate-limited NAT keeps hammering the endpoint on each
 *  navigation. Time-boxed, not permanent: a 500 during a deploy must not make
 *  the whole tab session uncapturable. */
const BACKOFF_KEY = "triply_attr_backoff_until";
const BACKOFF_MS = 5 * 60 * 1000;

function inBackoff(): boolean {
  try {
    const until = Number(sessionStorage.getItem(BACKOFF_KEY) ?? "0");
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}
function setBackoff(): void {
  try {
    sessionStorage.setItem(BACKOFF_KEY, String(Date.now() + BACKOFF_MS));
  } catch {
    /* storage blocked — the in-memory backoff below still applies */
  }
}

export function AttributionCapture() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const lastKey = useRef<string | null>(null);
  // document.referrer never changes across App Router soft navigations, so it
  // belongs to the LANDING page only. Consumed on the first NON-skipped page
  // view; every later page view is internal and must not look like a fresh
  // referral touch. (A skipped landing — e.g. /reservations from a webmail
  // link — leaves it intact for the next real page rather than discarding it.)
  const landingReferrer = useRef<string | null>(null);
  const backoffUntil = useRef(0);
  // Two page views inside one round-trip would both see "no cookie yet" and
  // both create a fresh `first`; whichever Set-Cookie lands last would win —
  // a paid landing could be overwritten by a direct one. One POST at a time.
  const inFlight = useRef(false);

  useEffect(() => {
    const key = `${pathname}?${search}`;
    if (lastKey.current === key) return;
    if (inFlight.current) return; // re-evaluated on the next navigation
    lastKey.current = key;
    if (isSkippedPath(pathname)) return;
    if (backoffUntil.current > Date.now() || inBackoff()) return;

    if (landingReferrer.current === null) landingReferrer.current = document.referrer;
    const referrer = landingReferrer.current;
    landingReferrer.current = "";

    let stateRaw: string | undefined;
    try {
      stateRaw = Cookies.get(ATTR_STATE_COOKIE);
    } catch {
      stateRaw = undefined;
    }
    const state = parseStateCookie(stateRaw);
    const liveSearch = window.location.search;
    const touch = buildTouch({ pathname, search: liveSearch, referrer });
    const apt = pageAirport(pathname, liveSearch);

    if (
      !isNewTouch({
        pathname,
        touch,
        knownAirport: state.apt,
        hasStateCookie: state.present,
        pageAirport: apt,
      })
    ) {
      return;
    }

    inFlight.current = true;
    void fetch("/api/attribution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ touch, ...(apt ? { apt } : {}) }),
      keepalive: true,
    })
      .then((res) => {
        if (!res.ok) {
          backoffUntil.current = Date.now() + BACKOFF_MS;
          setBackoff();
        }
      })
      .catch(() => {
        // Offline / aborted navigation — expected; the server never saw it.
        backoffUntil.current = Date.now() + BACKOFF_MS;
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [pathname, search]);

  return null;
}
