import { NextRequest, NextResponse } from "next/server";
import { getAirportByCode } from "@/config/airports";
import { getLotsByAirport, sortLots } from "@/lib/data/mock-lots";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const airport = searchParams.get("airport") || "JFK";
  const checkin = searchParams.get("checkin");
  const checkout = searchParams.get("checkout");
  const sort = searchParams.get("sort") || "popularity";

  // Validate airport
  const airportInfo = getAirportByCode(airport);
  if (!airportInfo) {
    return NextResponse.json(
      { error: "Invalid airport code" },
      { status: 400 }
    );
  }

  // Get and sort lots
  const lots = getLotsByAirport(airport);
  const sortedLots = sortLots(lots, sort);

  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 300));

  return NextResponse.json({
    airport: airportInfo,
    checkin,
    checkout,
    results: sortedLots,
    total: sortedLots.length,
  });
}
