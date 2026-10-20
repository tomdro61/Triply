import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Navbar } from "@/components/shared";
import { ParkStaySearchResults } from "@/components/park-stay/search-results";
import { parkStayAirports } from "@/lib/hotels/park-stay-airports";
import { parkStayViewerAllowed } from "@/lib/hotels/admin-preview";
import { HOTEL_LOTS } from "@/lib/hotels/hotel-lots";

// Never ISR / never static: the flag is read per process and the page must
// 404 when it is off (the post-deploy negative control, plan v3 §9.1) or the
// viewer is not a signed-in admin (the production preview, §20).
export const dynamic = "force-dynamic";

/**
 * Full-height list + map layout, as /search (CX plan v2 §3). The airports
 * (with their timezone and coordinates, from @/config/airports) and the map
 * hotels' names are resolved HERE, behind the gate, and passed down — the
 * `focus` banner names a hotel that isn't in the results from this list.
 */
export default async function ParkStayPage() {
  const airports = parkStayAirports();
  if (airports.length === 0) notFound();
  if (!(await parkStayViewerAllowed("/park-stay"))) notFound();
  const open = new Set(airports.map((a) => a.code));
  const hotels = HOTEL_LOTS.filter((e) => e.enabled && open.has(e.airport)).map((e) => ({ key: e.key, airport: e.airport, name: e.liteapi.name }));
  return (
    <div className="flex h-screen flex-col bg-white">
      <Navbar forceSolid />
      <main className="flex flex-1 flex-col overflow-hidden pt-20">
        <h1 className="sr-only">Park &amp; Stay</h1>
        <Suspense fallback={null}>
          <ParkStaySearchResults
            airports={airports.map((a) => ({ code: a.code, name: a.name, timezone: a.timezone, latitude: a.latitude, longitude: a.longitude }))}
            hotels={hotels}
          />
        </Suspense>
      </main>
    </div>
  );
}
