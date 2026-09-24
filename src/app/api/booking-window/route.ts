import { NextResponse } from "next/server";
import { format } from "date-fns";
import { MAX_ADVANCE_BOOKING_DAYS, maxAdvanceBookingDate } from "@/lib/booking-window";

/**
 * GET /api/booking-window
 *
 * `maxAdvanceBookingDate()` is `addDays(startOfDay(new Date()), N)` — computed
 * in whatever timezone the caller runs in. On Vercel that's UTC; in a US
 * browser it's local. Between ~19:00 and midnight ET the two disagree by a
 * day, so a client that computes its own max can offer a date the server then
 * rejects. This route makes the SERVER the single source of truth: clients
 * fetch it instead of calling maxAdvanceBookingDate() themselves.
 *
 * Public, read-only, no user input — no origin/rate-limit guard needed (see
 * src/lib/http/origin.ts for routes that do need one).
 *
 * force-dynamic + no-store: this recomputes off `new Date()`, so a cached
 * response would serve yesterday's (or an hour-old) maxDate — the exact
 * client/server disagreement this route exists to prevent, just moved from
 * "browser vs. server timezone" to "browser vs. a stale edge/CDN cache".
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const maxDate = maxAdvanceBookingDate();
  return NextResponse.json(
    {
      maxDate: format(maxDate, "yyyy-MM-dd"),
      days: MAX_ADVANCE_BOOKING_DAYS,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
