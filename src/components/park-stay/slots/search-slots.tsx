"use client";

/**
 * The /search page's Park & Stay slots (CX plan §12.1, §4): the mode switch
 * and the parking-card badge. The page calls useParkStayAccess() once and
 * mounts these only when it says visible; it hands over only the RAW URL
 * strings (R12-H3) — every mapping rule, and all the copy, is in the lazy
 * chunks (park-stay/entry/), each inside a boundary that renders nothing on
 * error.
 */

import dynamic from "next/dynamic";
import type { ParkStayAccess } from "@/lib/hotels/access";
import type { RawParkingSearch } from "../entry/from-parking";
import { SlotBoundary } from "./slot-boundary";

const LazySwitch = dynamic(() => import("../entry/parking-search-switch").then((m) => m.ParkingPageModeSwitch), { ssr: false, loading: () => null });
const LazyBadge = dynamic(() => import("../entry/parking-lot-badge").then((m) => m.ParkStayLotBadge), { ssr: false, loading: () => null });

/** Is the URL's airport one the access answer is open for? (Raw string in, no mapping.) */
export function isParkStayAirport(access: ParkStayAccess, rawAirport: string | null): boolean {
  if (rawAirport === null) return false;
  const code = rawAirport.trim().toUpperCase();
  return access.airports.some((a) => a.code.toUpperCase() === code);
}

export function ParkStaySearchSwitchSlot({ access, search }: { access: ParkStayAccess; search: RawParkingSearch }) {
  return (
    <SlotBoundary>
      <LazySwitch access={access} search={search} />
    </SlotBoundary>
  );
}

export function ParkStayLotBadgeSlot({ access, search, reslabLocationId }: { access: ParkStayAccess; search: RawParkingSearch; reslabLocationId: number | null }) {
  return (
    <SlotBoundary>
      <LazyBadge access={access} search={search} reslabLocationId={reslabLocationId} />
    </SlotBoundary>
  );
}
