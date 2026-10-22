/**
 * GET /api/lots/quote — the price of one lot for the dates and times on screen,
 * for the lot page booking box and the search slider. Display only: checkout
 * prices again from /api/checkout/lot before any payment.
 *
 * One upstream call per quote, because every date or time change makes one:
 *   - ResLab lot: min-price — the call search prices every card from. Its
 *     totals equal checkout's /costs quote for the same stay (checked to the
 *     cent on 5 stays across 3 airports, 2026-10-22). /api/checkout/lot GET
 *     would cost three calls (/locations/{id}, min-price, /costs).
 *   - Direct lot: quoteDirectCheckout, the function checkout charges from.
 *
 *   200 { quote }  the price for this stay
 *   422 { code }   this stay can't be booked: reversed or beyond the booking
 *                  window (checked here, before any upstream call), or ResLab /
 *                  the direct lot said no (400/404/422) — expected, not reported
 *   404            no such lot
 *   400            malformed request (not a real date or time)
 *   503            upstream unavailable — incl. ResLab auth failures and
 *                  timeouts; ResLab failures reported to Sentry, throttled
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { reslab, ReslabError } from "@/lib/reslab/client";
import { BLOCKED_RESLAB_LOCATION_IDS } from "@/lib/reslab/search";
import { quoteDirectCheckout } from "@/lib/direct/checkout-quote";
import { isDirectCheckoutOpen } from "@/lib/direct/flag";
import { parseDirectLotUnifiedId } from "@/lib/direct/store";
import { calculateServiceFee } from "@/lib/utils/service-fee";
import { convertTo24Hour } from "@/lib/utils/time";
import { captureAPIError } from "@/lib/sentry";
import { MAX_ADVANCE_BOOKING_DAYS } from "@/lib/booking-window";
import { priceViewFromQuote, type LotQuote } from "@/lib/pricing/price-view";

export const dynamic = "force-dynamic";
// ResLab's request timeout is 10 s per call; a cold instance authenticates
// first (another 10 s), and a 401 retry re-authenticates. Long enough that a
// hanging ResLab reaches the catch (503 + Sentry) instead of being killed.
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };
const ENDPOINT = "/api/lots/quote";

/** A real calendar date ("2026-13-45" is not). */
const isRealDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
};
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").refine(isRealDate, "Invalid date");
const time = z.string().regex(/^(1[0-2]|[1-9]):[0-5]\d\s[AP]M$/, "Invalid time");

const querySchema = z.object({
  lotId: z.string().regex(/^(reslab|direct)-\d{1,9}$/, "Invalid lot"),
  checkin: date,
  checkout: date,
  checkinTime: time,
  checkoutTime: time,
});

/** "YYYY-MM-DD" n days after today in UTC — a loose, timezone-safe bound
 *  (the airport's own today is at most a day off from it). */
const utcDatePlusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// One Sentry event per warm instance per 5 minutes: during a ResLab outage every
// date or time change on every lot page fails, and the search route already
// reports the outage itself.
const CAPTURE_EVERY_MS = 5 * 60_000;
let lastCaptureAt = 0;
let suppressedSinceCapture = 0;
function captureThrottled(error: unknown, extra: Record<string, unknown>) {
  const now = Date.now();
  if (now - lastCaptureAt < CAPTURE_EVERY_MS) {
    suppressedSinceCapture++;
    return;
  }
  captureAPIError(error instanceof Error ? error : new Error(String(error)), {
    endpoint: ENDPOINT,
    method: "GET",
    statusCode: 503,
    extra: { ...extra, suppressedSinceLastEvent: suppressedSinceCapture },
  });
  lastCaptureAt = now;
  suppressedSinceCapture = 0;
}

const notBookable = (code: string) => NextResponse.json({ code }, { status: 422, headers: NO_STORE });

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    lotId: sp.get("lotId") ?? undefined,
    checkin: sp.get("checkin") ?? undefined,
    checkout: sp.get("checkout") ?? undefined,
    checkinTime: sp.get("checkinTime") ?? undefined,
    checkoutTime: sp.get("checkoutTime") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400, headers: NO_STORE });
  }
  const { lotId, checkin, checkout, checkinTime, checkoutTime } = parsed.data;
  const fromDate = `${checkin} ${convertTo24Hour(checkinTime)}:00`;
  const toDate = `${checkout} ${convertTo24Hour(checkoutTime)}:00`;
  // Stays no customer can book, refused before any upstream call: ResLab
  // prices a reversed range as nonsense (TRIPLY-31/34). Wall-clock strings
  // compare exactly; a check-in already past is ResLab's to refuse (its own
  // timezone rules), which comes back as 422 below.
  if (toDate <= fromDate) return notBookable("checkout_not_after_checkin");
  if (checkin > utcDatePlusDays(MAX_ADVANCE_BOOKING_DAYS + 1)) return notBookable("beyond_booking_window");

  if (lotId.startsWith("direct-")) {
    const payloadId = parseDirectLotUnifiedId(lotId);
    if (payloadId === null) return NextResponse.json({ error: "Lot not found" }, { status: 404, headers: NO_STORE });
    if (!isDirectCheckoutOpen()) return notBookable("direct_not_bookable_yet");
    // quoteDirectCheckout's store read reports its own failures (throttled).
    const direct = await quoteDirectCheckout({ payloadId, fromDate, toDate, endpoint: ENDPOINT });
    if (!direct.ok) {
      if (direct.status === 400) return notBookable(direct.code);
      return NextResponse.json({ code: direct.code }, { status: direct.status, headers: NO_STORE });
    }
    const q = direct.quote;
    const quote: LotQuote = {
      grandTotal: q.grandTotalCents / 100,
      subtotal: q.subtotalCents / 100,
      feesTotal: 0,
      taxTotal: q.taxTotalCents / 100,
      serviceFee: q.serviceFeeCents / 100,
      dueAtLocation: 0,
      numberOfDays: direct.days,
      soldOut: false,
    };
    return NextResponse.json({ quote }, { headers: NO_STORE });
  }

  const locationId = Number(lotId.slice("reslab-".length));
  if (BLOCKED_RESLAB_LOCATION_IDS.has(locationId)) {
    return NextResponse.json({ error: "Lot not found" }, { status: 404, headers: NO_STORE });
  }
  try {
    const { reservation: r } = await reslab.getMinPrice(locationId, {
      type: "parking",
      reservation_type: "parking",
      from_date: fromDate,
      to_date: toDate,
      number_of_spots: 1,
    });
    const quote: LotQuote = {
      grandTotal: r.grand_total,
      subtotal: r.sub_total,
      feesTotal: r.fees_total,
      taxTotal: r.tax_total,
      // Same fee rule and base as /api/checkout/lot: max($5.95, 6 % of sub_total + fees_total).
      serviceFee: calculateServiceFee(r.sub_total + r.fees_total),
      dueAtLocation: r.due_at_location,
      numberOfDays: r.totals?.parking?.number_of_days,
      soldOut: r.sold_out || r.parking_sold_out,
    };
    // An answer whose parts don't make a price (ResLab's $0.00 min-price, a
    // missing field, parts short of the grand total) would only show the
    // customer "couldn't update the price" — so it is reported here, where the
    // lot and stay are known, and answered as unavailable.
    if (!quote.soldOut && priceViewFromQuote(quote) === null) {
      captureThrottled(new Error(`ResLab min-price answer for lot ${locationId} does not make a price`), {
        lotId,
        fromDate,
        toDate,
        quote,
      });
      return NextResponse.json({ error: "Pricing is temporarily unavailable" }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ quote }, { headers: NO_STORE });
  } catch (error) {
    // ResLab understood and said no to THIS stay (notice period, past time,
    // closed lot): the customer's answer, not an outage. Only these statuses —
    // a 401/403 (our key or channel) or 429 is ours to fix and must not tell
    // every customer their stay can't be booked.
    if (error instanceof ReslabError && (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 422)) {
      return notBookable(error.statusCode === 404 ? "reslab_not_found" : "reslab_rejected");
    }
    captureThrottled(error, {
      lotId,
      fromDate,
      toDate,
      statusCode: error instanceof ReslabError ? error.statusCode : undefined,
    });
    return NextResponse.json({ error: "Pricing is temporarily unavailable" }, { status: 503, headers: NO_STORE });
  }
}
