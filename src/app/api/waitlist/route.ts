import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { addDays, format, isValid, parse, startOfDay, subDays } from "date-fns";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { getAirportByCode } from "@/config/airports";
import { MAX_ADVANCE_BOOKING_DAYS, maxAdvanceBookingDate } from "@/lib/booking-window";
import { captureAPIError } from "@/lib/sentry";
import { isSameOrigin, clientKey } from "@/lib/http/origin";
import { checkWaitlistRateLimit } from "@/lib/attribution/limiter";
import { waitlistUnsubscribeUrl } from "@/lib/waitlist/unsubscribe-token";

/**
 * Waitlist for trips beyond the supplier's 60-day booking wall.
 *
 * ResLab returns HTTP 422 for any check-in further out than
 * MAX_ADVANCE_BOOKING_DAYS, so these travellers cannot be sold to yet. We take
 * the email and the date instead, and record the day their trip becomes
 * bookable (opens_on). GET /api/cron/waitlist-notify is what actually sends
 * that day's email — see migration 026.
 *
 * Unauthenticated and visitor-facing (mints a Resend send per new tuple), so
 * it carries the same guards as /api/newsletter and /api/attribution:
 * same-origin only, a bounded per-IP limiter, a measured body cap, and a
 * per-email send cap on top (an attacker who clears the IP limiter by
 * rotating IPs still can't make us spam one address).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const MAX_BODY_BYTES = 2048;
const DATE_FORMAT = "yyyy-MM-dd";

// Above this many confirmation sends to the same address in 24h, keep writing
// the row (it's still a real demand signal) but stop emailing — an attacker
// who wants to hammer one inbox gets throttled even from many IPs.
const MAX_SENDS_PER_EMAIL_PER_DAY = 3;

/** Parses a YYYY-MM-DD string to a local start-of-day Date, or null. */
function parseDateOnly(value: string): Date | null {
  const parsed = parse(value, DATE_FORMAT, new Date());
  return isValid(parsed) ? startOfDay(parsed) : null;
}

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine((v) => parseDateOnly(v) !== null, "Not a real date");

const waitlistSchema = z.object({
  // .trim() FIRST: zod runs .email() before any downstream transform, so a
  // pasted address with stray whitespace would otherwise be rejected outright.
  email: z
    .string()
    .trim()
    .email("Invalid email address")
    .max(254)
    .transform((v) => v.toLowerCase()),
  airportCode: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "Invalid airport code")
    .transform((v) => v.toUpperCase())
    .refine((v) => getAirportByCode(v)?.enabled === true, "Unknown airport"),
  wantedCheckin: dateOnly.refine(
    (v) => parseDateOnly(v)! <= addDays(startOfDay(new Date()), 730),
    "Travel date is too far out"
  ),
  source: z
    .string()
    .max(32)
    .regex(/^[a-z0-9_-]+$/, "Invalid source")
    .optional(),
  page: z.string().max(200).optional(),
});

// Once-per-instance telemetry for each rejection class, same pattern as
// /api/newsletter and /api/attribution — sampling, not suppression.
const reported = new Set<string>();
export function __resetWaitlistRouteTelemetryForTests(): void {
  reported.clear();
}
function reportOnce(kind: string, context: Record<string, unknown>) {
  if (reported.has(kind)) return;
  reported.add(kind);
  try {
    Sentry.withScope((scope) => {
      scope.setFingerprint([`waitlist_post_${kind}`]);
      scope.setContext("waitlist", context);
      Sentry.captureMessage(`POST /api/waitlist rejected: ${kind}`, "warning");
    });
  } catch {
    /* never let telemetry affect the response */
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    reportOnce("403_origin", {
      secFetchSite: request.headers.get("sec-fetch-site"),
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkWaitlistRateLimit(clientKey(request))) {
    reportOnce("429_rate_limited", {});
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Measure the body that actually arrived: Content-Length is absent on a
  // chunked request, so a header check alone is bypassable.
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    reportOnce("413_body", { length: text.length });
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    reportOnce("400_json", {});
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = waitlistSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    const { email, airportCode, wantedCheckin, source, page } = result.data;

    // Non-null: the schema already refused anything parseDateOnly rejects.
    const checkin = parseDateOnly(wantedCheckin)!;
    const maxDate = maxAdvanceBookingDate();

    // The whole point of this endpoint is the dates we CANNOT sell. Anything
    // clearly inside the window is a booking, not a waitlist entry — say so
    // rather than quietly storing a lead we could have converted on the spot.
    //
    // Strictly LESS than maxDate, not <=: maxAdvanceBookingDate() is computed
    // in the server's timezone (UTC on Vercel) while a browser computes its
    // own copy in local time, so between ~19:00-midnight ET the two can
    // disagree by a day. A checkin landing on maxDate itself, or the day
    // after, is that ≤1-day straddle — accept it as a waitlist entry rather
    // than bounce a traveller whose own browser told them this date wasn't
    // bookable yet.
    if (checkin < maxDate) {
      return NextResponse.json(
        {
          error: `Good news — ${airportCode} is already open for ${format(
            checkin,
            "MMM d"
          )}. You can book that trip now.`,
        },
        { status: 400 }
      );
    }

    // The day their trip slides into ResLab's window — the day we can email.
    const opensOn = subDays(checkin, MAX_ADVANCE_BOOKING_DAYS);
    const opensOnISO = format(opensOn, DATE_FORMAT);

    const supabase = await createAdminClient();

    // Per-email send cap: count confirmations already triggered by this
    // address in the last 24h. The row below may still be written even when
    // we refuse to send — it's still a real demand signal, and a duplicate
    // trip is already deduped by the unique index regardless.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentSends } = await supabase
      .from("booking_waitlist")
      .select("id")
      .eq("email", email)
      .gte("created_at", since);
    const overSendCap = (recentSends?.length ?? 0) >= MAX_SENDS_PER_EMAIL_PER_DAY;

    const { data: inserted, error: insertError } = await supabase
      .from("booking_waitlist")
      .insert({
        email,
        airport_code: airportCode,
        wanted_checkin: wantedCheckin,
        wanted_checkout: null,
        opens_on: opensOnISO,
        source: source ?? "search",
        page: page ?? null,
      })
      .select("id")
      .single();

    // 23505 = the (lower(email), airport_code, wanted_checkin) unique index.
    // They already asked for this exact trip: succeed silently and do NOT send
    // the confirmation a second time.
    const isDuplicate = insertError?.code === "23505";

    if (insertError && !isDuplicate) {
      captureAPIError(new Error(insertError.message), {
        endpoint: "/api/waitlist",
        method: "POST",
        stage: "insert",
        code: insertError.code,
      });
      return NextResponse.json(
        { error: "Failed to join the waitlist" },
        { status: 500 }
      );
    }

    if (!isDuplicate && !overSendCap && inserted) {
      // Email failure must never fail the request — the row is the asset.
      try {
        await sendWaitlistConfirmation({
          id: inserted.id as string,
          email,
          airportCode,
          checkin,
          opensOn,
        });
      } catch (emailError) {
        captureAPIError(
          emailError instanceof Error ? emailError : new Error(String(emailError)),
          { endpoint: "/api/waitlist", method: "POST", stage: "confirmation_email" }
        );
      }
    } else if (overSendCap) {
      reportOnce("send_cap_exceeded", { email });
    }

    return NextResponse.json({ success: true, opensOn: opensOnISO });
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/waitlist",
      method: "POST",
    });
    return NextResponse.json(
      { error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}

async function sendWaitlistConfirmation({
  id,
  email,
  airportCode,
  checkin,
  opensOn,
}: {
  id: string;
  email: string;
  airportCode: string;
  checkin: Date;
  opensOn: Date;
}) {
  const airport = getAirportByCode(airportCode);
  const airportName = airport ? `${airport.city} (${airportCode})` : airportCode;
  const tripDate = format(checkin, "MMMM d, yyyy");
  const opensDate = format(opensOn, "MMMM d, yyyy");
  const unsubscribeUrl = waitlistUnsubscribeUrl(id);

  // Promises exactly one thing — an email on opens_on. No discount, no list.
  await resend.emails.send({
    from: FROM_EMAIL,
    to: [email],
    subject: `We'll tell you the day ${airportCode} opens for ${format(
      checkin,
      "MMM d"
    )}`,
    headers: { "List-Unsubscribe": `<${unsubscribeUrl}>` },
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <div style="background-color: #1A1A2E; padding: 32px 40px; text-align: center;">
          <h1 style="margin: 0; color: #f87356; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Triply</h1>
          <p style="margin: 4px 0 0; color: #94a3b8; font-size: 13px;">Your Trip Simplified</p>
        </div>
        <div style="padding: 40px;">
          <h2 style="margin: 0 0 20px; color: #111827; font-size: 20px; font-weight: 700;">You're on the list</h2>
          <p style="font-size: 15px; color: #374151; line-height: 1.6;">
            Parking at ${airportName} for <strong>${tripDate}</strong> is too far ahead to reserve right now &mdash; lots only release their dates ${MAX_ADVANCE_BOOKING_DAYS} days in advance.
          </p>
          <div style="background-color: #f9fafb; padding: 24px; border-radius: 8px; border: 2px dashed #f87356; text-align: center; margin: 24px 0;">
            <p style="font-size: 13px; color: #9ca3af; margin: 0 0 8px;">Bookings open on</p>
            <p style="font-size: 24px; font-weight: bold; color: #f87356; margin: 0;">${opensDate}</p>
          </div>
          <p style="font-size: 15px; color: #374151; line-height: 1.6;">
            We'll email you that day so you can book ${airportCode} as soon as it's available. That's the only email you'll get from this &mdash; nothing else.
          </p>
        </div>
        <div style="background-color: #f9fafb; padding: 24px 40px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="margin: 0; color: #9ca3af; font-size: 12px;">
            Triply - Airport Parking Made Easy<br>
            <a href="https://www.triplypro.com" style="color: #f87356; text-decoration: none;">triplypro.com</a><br>
            <a href="${unsubscribeUrl}" style="color: #9ca3af; text-decoration: underline;">Unsubscribe</a>
          </p>
        </div>
      </div>
    `,
  });
}
