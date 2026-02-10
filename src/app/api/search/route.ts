import { NextRequest, NextResponse } from "next/server";
import { searchParking } from "@/lib/reslab/search";
import { SortOption } from "@/types/lot";
import { captureAPIError } from "@/lib/sentry";
import { z } from "zod";

const searchQuerySchema = z.object({
  airport: z.string().min(2).max(10),
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  checkinTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Invalid time format").optional(),
  checkoutTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Invalid time format").optional(),
  sort: z.enum(["popularity", "price_asc", "price_desc", "rating", "distance"]).optional(),
});

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  // Validate query parameters
  const validation = searchQuerySchema.safeParse({
    airport: searchParams.get("airport") || "JFK",
    checkin: searchParams.get("checkin") || undefined,
    checkout: searchParams.get("checkout") || undefined,
    checkinTime: searchParams.get("checkinTime") || undefined,
    checkoutTime: searchParams.get("checkoutTime") || undefined,
    sort: searchParams.get("sort") || undefined,
  });

  if (!validation.success) {
    return NextResponse.json(
      { error: "Invalid search parameters", fields: validation.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const airport = searchParams.get("airport") || "JFK";
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const checkin = searchParams.get("checkin") || tomorrow.toISOString().split("T")[0];
  const checkout =
    searchParams.get("checkout") ||
    new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const checkinTime = searchParams.get("checkinTime") || "10:00 AM";
  const checkoutTime = searchParams.get("checkoutTime") || "2:00 PM";
  const sort = (searchParams.get("sort") || "popularity") as SortOption;

  try {
    const result = await searchParking({
      airport,
      checkin,
      checkout,
      checkinTime,
      checkoutTime,
      sort,
    });

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    console.error("Search API error:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/search",
      method: "GET",
    });

    if (error instanceof Error && error.message.startsWith("Invalid airport code")) {
      return NextResponse.json(
        { error: "Invalid airport code" },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Failed to search for parking" },
      { status: 500 }
    );
  }
}
