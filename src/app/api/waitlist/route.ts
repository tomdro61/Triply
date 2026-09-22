import crypto from "crypto";
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

const waitlistSchema = z
  .object({
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
    // Optional: the confirmation email doesn't need it, but the opens-on
    // notification links to /search, which needs BOTH dates to price a lot
    // (see the cron's checkout fallback comment). Bounded to 30 days so a
    // garbage/typo'd far-future checkout can't produce a nonsense search link.
    wantedCheckout: dateOnly.optional(),
    source: z
      .string()
      .max(32)
      .regex(/^[a-z0-9_-]+$/, "Invalid source")
      .optional(),
    page: z.string().max(200).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.wantedCheckout) return;
    const checkin = parseDateOnly(data.wantedCheckin)!;
    const checkout = parseDateOnly(data.wantedCheckout)!;
    if (checkout <= checkin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Checkout must be after check-in",
        path: ["wantedCheckout"],
      });
    } else if (checkout > addDays(checkin, 30)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Checkout must be within 30 days of check-in",
        path: ["wantedCheckout"],
      });
    }
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

    const { email, airportCode, wantedCheckin, wantedCheckout, source, page } = result.data;

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

    // One query answers both the per-email send cap AND the unsubscribe
    // suppression check below — this address's own row history. Small set
    // (one email, no time bound) so a full scan of it is cheap; the
    // (email, created_at) index (026) still makes the `.eq("email")` itself
    // an index lookup rather than a table scan.
    const { data: emailRows, error: emailRowsError } = await supabase
      .from("booking_waitlist")
      .select("id, created_at, unsubscribed_at")
      .eq("email", email);

    // Fail CLOSED: the cap and the unsubscribe suppression both exist to stop
    // us from emailing someone we shouldn't. If we can't see this address's
    // history, we don't know whether either guard should fire — refuse the
    // send rather than silently open both gates. The row is not written
    // either (it, and the email, are both blocked on knowing this state).
    if (emailRowsError) {
      captureAPIError(new Error(emailRowsError.message), {
        endpoint: "/api/waitlist",
        method: "POST",
        stage: "email_history_check",
        code: emailRowsError.code,
      });
      return NextResponse.json(
        { error: "Failed to join the waitlist" },
        { status: 503 }
      );
    }

    const history = emailRows ?? [];

    // Unsubscribe is address-level (item 4): any row for this email that was
    // ever unsubscribed suppresses ALL future sends to it, not just the row
    // that carried the unsubscribe link. Refuse to create a new row too —
    // resurrecting a suppressed address via a fresh trip would defeat the
    // point of the opt-out.
    if (history.some((r) => r.unsubscribed_at != null)) {
      return NextResponse.json(
        {
          error:
            "This email has unsubscribed from waitlist notifications. Contact support if this was a mistake.",
        },
        { status: 403 }
      );
    }

    // Per-email send cap: count confirmations already triggered by this
    // address in the last 24h. The row below may still be written even when
    // we refuse to send — it's still a real demand signal, and a duplicate
    // trip is already deduped by the unique index regardless.
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const overSendCap =
      history.filter((r) => new Date(r.created_at as string).getTime() >= since).length >=
      MAX_SENDS_PER_EMAIL_PER_DAY;

    const { data: inserted, error: insertError } = await supabase
      .from("booking_waitlist")
      .insert({
        email,
        airport_code: airportCode,
        wanted_checkin: wantedCheckin,
        wanted_checkout: wantedCheckout ?? null,
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

    if (isDuplicate) {
      // Same trip already on file — the row was already written the first
      // time; don't send a second confirmation.
    } else if (overSendCap) {
      // Never put the customer's email into Sentry/telemetry for a routine,
      // expected-volume event — a short, non-reversible hash is enough to
      // dedupe/rate-limit the telemetry itself without shipping PII.
      reportOnce("send_cap_exceeded", {
        emailHash: crypto.createHash("sha256").update(email).digest("hex").slice(0, 16),
      });
      // Row is still written (see the insert above) — it's still a real
      // demand signal — but honestly report that no email is going out,
      // rather than the generic success message that implies one did.
      return NextResponse.json({
        success: true,
        opensOn: opensOnISO,
        message:
          "We already have your request on file; we won't send another email today.",
      });
    } else if (inserted) {
      // Email failure must never fail the request — the row is the asset.
      // sendWaitlistConfirmation throws on a Resend API error (never a silent
      // {error} return), so this catch is the only place that failure surfaces.
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

  // resend@6.9.1 never throws for an API-level failure — it resolves
  // { data: null, error }. Destructure and throw ourselves so the caller's
  // catch (which reports to Sentry and never claims the email sent) is
  // actually reachable; see src/lib/resend/*.ts for the reference pattern.
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [email],
    subject: `We'll tell you the day ${airportCode} opens for ${format(
      checkin,
      "MMM d"
    )}`,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
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

  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
}
