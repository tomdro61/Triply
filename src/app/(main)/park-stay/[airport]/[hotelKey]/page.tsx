import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Navbar, Footer } from "@/components/shared";
import { ParkStayHotelDetail } from "@/components/park-stay/hotel-detail";
import { parkStayAirport } from "@/lib/hotels/park-stay-airports";
import { findEnabledHotelLot } from "@/lib/hotels/hotel-lots";
import { parkStayViewerAllowed } from "@/lib/hotels/admin-preview";

export const dynamic = "force-dynamic";

/** notFound() when the flag is off, the airport isn't open, the viewer isn't a signed-in admin (§20), or the key is unknown, disabled or another airport's (§8.1). */
export default async function ParkStayHotelPage({ params }: { params: Promise<{ airport: string; hotelKey: string }> }) {
  const { airport: airportParam, hotelKey } = await params;
  if (!/^[A-Za-z]{3}$/.test(airportParam) || !/^[a-z0-9-]{1,64}$/.test(hotelKey)) notFound();
  const airport = parkStayAirport(airportParam);
  if (!airport) notFound();
  if (!(await parkStayViewerAllowed("/park-stay/[airport]/[hotelKey]"))) notFound();
  const entry = findEnabledHotelLot(airport.code, hotelKey);
  if (!entry) notFound();
  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Suspense fallback={null}>
          <ParkStayHotelDetail airport={airport.code} hotelKey={entry.key} mapName={entry.liteapi.name} />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
