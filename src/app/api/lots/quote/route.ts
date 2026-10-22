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
 *   422 { code }   this stay can't be booked (ResLab or the direct lot said no) — expected, not reported
 *   404            no such lot
 *   400            malformed request
 *   503            upstream unavailable — ResLab failures reported to Sentry, throttled
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
import type { LotQuote } from "@/lib/pricing/price-view";

export const dynamic = "force-dynamic";
// ResLab's own request timeout is 10 s; leave room for it to answer.
export const maxDuration = 15;

const NO_STORE = { "Cache-Control": "no-store" };
const ENDPOINT = "/api/lots/quote";

const querySchema = z.object({
  lotId: z.string().regex(/^(reslab|direct)-\d{1,9}$/, "Invalid lot"),
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  checkinTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Check-in time is required"),
  checkoutTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Check-out time is required"),
});

// One Sentry event per warm instance per 5 minutes: during a ResLab outage every
// date or time change on every lot page fails, and the search route already
// reports the outage itself.
const CAPTURE_EVERY_MS = 5 * 60_000;
let lastCaptureAt = 0;
let suppressedSinceCapture = 0;
function captureThrottled(error: unknown) {
  const now = Date.now();
  if (now - lastCaptureAt < CAPTURE_EVERY_MS) {
    suppressedSinceCapture++;
    return;
  }
  captureAPIError(error instanceof Error ? error : new Error(String(error)), {
    endpoint: ENDPOINT,
    method: "GET",
    statusCode: 503,
    extra: { suppressedSinceLastEvent: suppressedSinceCapture },
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
    return NextResponse.json({ quote }, { headers: NO_STORE });
  } catch (error) {
    // ResLab understood and said no (notice period, past time, closed lot):
    // the stay can't be booked — the customer's answer, not an outage.
    if (error instanceof ReslabError && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) {
      return notBookable(error.statusCode === 404 ? "reslab_not_found" : "reslab_rejected");
    }
    captureThrottled(error);
    return NextResponse.json({ error: "Pricing is temporarily unavailable" }, { status: 503, headers: NO_STORE });
  }
}
