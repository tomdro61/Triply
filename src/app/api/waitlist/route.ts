import { NextRequest, NextResponse } from "next/server";
import { format, isValid, parse, startOfDay, subDays } from "date-fns";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { getAirportByCode } from "@/config/airports";
import { MAX_ADVANCE_BOOKING_DAYS, maxAdvanceBookingDate } from "@/lib/booking-window";
import { captureAPIError } from "@/lib/sentry";

/**
 * Waitlist for trips beyond the supplier's 60-day booking wall.
 *
 * ResLab returns HTTP 422 for any check-in further out than
 * MAX_ADVANCE_BOOKING_DAYS, so these travellers cannot be sold to yet. We take
 * the email and the date instead, and record the day their trip becomes
 * bookable (opens_on). Nothing sends from that record yet — see migration 025.
 */

const DATE_FORMAT = "yyyy-MM-dd";

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
    .max(4)
    .transform((v) => v.toUpperCase())
    .refine((v) => getAirportByCode(v) !== undefined, "Unknown airport"),
  wantedCheckin: dateOnly,
  wantedCheckout: dateOnly.optional(),
  source: z
    .string()
    .max(32)
    .regex(/^[a-z0-9_-]+$/, "Invalid source")
    .optional(),
  page: z.string().max(200).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = waitlistSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    const { email, airportCode, wantedCheckin, wantedCheckout, source, page } =
      result.data;

    // Non-null: the schema already refused anything parseDateOnly rejects.
    const checkin = parseDateOnly(wantedCheckin)!;
    const maxDate = maxAdvanceBookingDate();

    // The whole point of this endpoint is the dates we CANNOT sell. Anything
    // inside the window is a booking, not a waitlist entry — say so rather than
    // quietly storing a lead we could have converted on the spot.
    if (checkin <= maxDate) {
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

    if (wantedCheckout) {
      const checkout = parseDateOnly(wantedCheckout)!;
      if (checkout < checkin) {
        return NextResponse.json(
          { error: "Return date must be on or after the departure date" },
          { status: 400 }
        );
      }
    }

    // The day their trip slides into ResLab's window — the day we can email.
    const opensOn = subDays(checkin, MAX_ADVANCE_BOOKING_DAYS);
    const opensOnISO = format(opensOn, DATE_FORMAT);

    const supabase = await createAdminClient();

    const { error: insertError } = await supabase.from("booking_waitlist").insert({
      email,
      airport_code: airportCode,
      wanted_checkin: wantedCheckin,
      wanted_checkout: wantedCheckout ?? null,
      opens_on: opensOnISO,
      source: source ?? "search",
      page: page ?? null,
    });

    // 23505 = the (lower(email), airport_code, wanted_checkin) unique index.
    // They already asked for this exact trip: succeed silently and do NOT send
    // the confirmation a second time.
    const isDuplicate = insertError?.code === "23505";

    if (insertError && !isDuplicate) {
      console.error("Waitlist insert failed:", insertError);
      return NextResponse.json(
        { error: "Failed to join the waitlist" },
        { status: 500 }
      );
    }

    if (!isDuplicate) {
      // Email failure must never fail the request — the row is the asset.
      try {
        await sendWaitlistConfirmation({ email, airportCode, checkin, opensOn });
      } catch (emailError) {
        console.error("Waitlist confirmation email failed:", emailError);
      }
    }

    return NextResponse.json({ success: true, opensOn: opensOnISO });
  } catch (error) {
    console.error("Waitlist signup error:", error);
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
  email,
  airportCode,
  checkin,
  opensOn,
}: {
  email: string;
  airportCode: string;
  checkin: Date;
  opensOn: Date;
}) {
  const airport = getAirportByCode(airportCode);
  const airportName = airport ? `${airport.city} (${airportCode})` : airportCode;
  const tripDate = format(checkin, "MMMM d, yyyy");
  const opensDate = format(opensOn, "MMMM d, yyyy");

  // Promises exactly one thing — an email on opens_on. No discount, no list.
  await resend.emails.send({
    from: FROM_EMAIL,
    to: [email],
    subject: `We'll tell you the day ${airportCode} opens for ${format(
      checkin,
      "MMM d"
    )}`,
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
            <a href="https://www.triplypro.com" style="color: #f87356; text-decoration: none;">triplypro.com</a>
          </p>
        </div>
      </div>
    `,
  });
}
