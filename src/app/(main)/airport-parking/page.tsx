import { Metadata } from "next";
import Link from "next/link";
import { Plane } from "lucide-react";
import { productionAirports } from "@/config/airports";
import { Navbar, Footer } from "@/components/shared";
import { Newsletter } from "@/components/shared/newsletter";
import { JsonLd } from "@/components/seo/JsonLd";

export const metadata: Metadata = {
  title: "Airport Parking - Compare Cheap Rates at 85+ Airports",
  description:
    "Find and compare off-airport parking at 85+ US airports. Book online, save up to 60%, and get free cancellation. Your trip, simplified.",
  alternates: {
    canonical: "https://www.triplypro.com/airport-parking",
  },
  openGraph: {
    title: "Airport Parking at 85+ US Airports",
    description:
      "Compare parking lots, check rates, and book online at 85+ airports. Save up to 60%.",
    url: "https://www.triplypro.com/airport-parking",
    type: "website",
  },
};

// Group airports by region
function getRegion(state: string): string {
  const regions: Record<string, string[]> = {
    Northeast: ["NY", "NJ", "CT", "MA", "PA", "RI", "VT", "NH", "ME", "MD", "DE", "DC"],
    Southeast: ["FL", "GA", "NC", "SC", "VA", "TN", "AL", "MS", "LA", "KY", "WV", "AR"],
    Midwest: ["IL", "OH", "MI", "IN", "WI", "MN", "MO", "IA", "KS", "NE", "ND", "SD"],
    West: ["CA", "WA", "OR", "NV", "AZ", "CO", "UT", "NM", "ID", "MT", "WY", "HI", "AK"],
    South: ["TX", "OK"],
  };

  for (const [region, states] of Object.entries(regions)) {
    if (states.includes(state)) return region;
  }
  return "Other";
}

const REGION_ORDER = ["Northeast", "Southeast", "Midwest", "South", "West", "Other"];

export default function AirportParkingHubPage() {
  const grouped = new Map<string, typeof productionAirports>();

  for (const airport of productionAirports) {
    const region = getRegion(airport.state);
    if (!grouped.has(region)) grouped.set(region, []);
    grouped.get(region)!.push(airport);
  }

  // Sort airports within each region by city name
  for (const airports of grouped.values()) {
    airports.sort((a, b) => a.city.localeCompare(b.city));
  }

  const itemListSchema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Airport Parking Locations",
    numberOfItems: productionAirports.length,
    itemListElement: productionAirports.map((airport, idx) => ({
      "@type": "ListItem",
      position: idx + 1,
      name: `${airport.name} Parking`,
      url: `https://www.triplypro.com/${airport.slug}/airport-parking`,
    })),
  };

  return (
    <>
      <JsonLd data={itemListSchema} />
      <Navbar forceSolid />

      <div className="bg-gradient-to-br from-brand-dark via-brand-dark to-[#2a2a4e] py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-3xl md:text-5xl font-bold text-white mb-4">
            Airport Parking
          </h1>
          <p className="text-gray-400 text-base md:text-lg max-w-2xl mx-auto">
            Compare off-airport parking at {productionAirports.length} airports across the US.
            Book online, save up to 60%, and enjoy free cancellation.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {REGION_ORDER.filter((r) => grouped.has(r)).map((region) => {
          const airports = grouped.get(region)!;
          return (
            <div key={region} className="mb-12 last:mb-0">
              <h2 className="text-xl font-bold text-gray-900 mb-4 border-b border-gray-200 pb-2">
                {region}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {airports.map((airport) => (
                  <Link
                    key={airport.code}
                    href={`/${airport.slug}/airport-parking`}
                    className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-brand-orange/30 hover:shadow-sm transition-all group"
                  >
                    <div className="w-9 h-9 rounded-full bg-gray-100 group-hover:bg-brand-orange/10 flex items-center justify-center shrink-0 transition-colors">
                      <Plane className="w-4 h-4 text-gray-400 group-hover:text-brand-orange transition-colors" />
                    </div>
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-gray-900 block truncate group-hover:text-brand-orange transition-colors">
                        {airport.city} ({airport.code})
                      </span>
                      <span className="text-xs text-gray-400 block truncate">
                        {airport.name}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <Newsletter />
      <Footer />
    </>
  );
}
