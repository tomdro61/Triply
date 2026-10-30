"use client";

/**
 * The mode switch on /search (CX plan §12.1), loaded lazily by the slot in
 * slots/search-slots.tsx. It gets the RAW URL strings and does all the
 * mapping here (R12-H3), so none of it is in /search's first-load JS.
 */

import type { ParkStayAccess } from "@/lib/hotels/access";
import { SearchModeSwitch } from "../search-mode-switch";
import { parkStayFromParking, type RawParkingSearch } from "./from-parking";

export function ParkingPageModeSwitch({ access, search }: { access: ParkStayAccess; search: RawParkingSearch }) {
  const side = parkStayFromParking(search, access, new Date());
  if (side.kind === "hidden") return null;
  return (
    <SearchModeSwitch
      mode="parking"
      parking={{ href: side.parkingHref }}
      parkStay={side.kind === "enabled" ? { href: side.href } : { disabledReason: side.reason }}
    />
  );
}
