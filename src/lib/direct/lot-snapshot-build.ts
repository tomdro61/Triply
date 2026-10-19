import { parseLotSnapshotV2, type LotSnapshotV2 } from "./lot-snapshot";
import type { DirectLot } from "./store";

// Separate from lot-snapshot.ts on purpose: the engine and the read paths parse
// snapshots and must never import the lot store (A-42 static test); only the
// staging route BUILDS one, from a fresh lot read.
/**
 * Build the v2 snapshot from a FRESH lot read (server side only). Validated
 * before it is returned: a lot whose data would not round-trip (a state that is
 * not two letters, an empty zip) is refused at staging — before the charge —
 * rather than stored and found broken at fulfilment or on the confirmation page.
 */
export function buildLotSnapshotV2(lot: DirectLot): LotSnapshotV2 | null {
  return parseLotSnapshotV2({
    v: 2,
    directLotId: String(lot.payloadId),
    name: lot.name,
    slug: lot.slug,
    airportCode: lot.airportCode,
    timezone: lot.timezone,
    address: { ...lot.address },
    coordinates: { ...lot.coordinates },
    shuttleDetails: lot.shuttleDetails,
    shuttlePhone: lot.shuttlePhone,
    bookingInstructions: { ...lot.bookingInstructions },
  });
}
