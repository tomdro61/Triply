import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Navbar, Footer } from "@/components/shared";
import { ParkStaySearchResults } from "@/components/park-stay/search-results";
import { parkStayAirports } from "@/lib/hotels/park-stay-airports";

// Never ISR / never static: the flag is read per process and the page must
// 404 when it is off (the post-deploy negative control, plan v3 §9.1).
export const dynamic = "force-dynamic";

export default function ParkStayPage() {
  const airports = parkStayAirports();
  if (airports.length === 0) notFound();
  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="mb-4 font-heading text-2xl font-bold">Park &amp; Stay</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          A hotel room the night before your flight, with parking at that same hotel until you get back.
        </p>
        <Suspense fallback={null}>
          <ParkStaySearchResults airports={airports.map((a) => ({ code: a.code, name: a.name }))} />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}
