import { NextRequest, NextResponse } from "next/server";
import { format } from "date-fns";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { getAirportByCode } from "@/config/airports";
import { captureAPIError } from "@/lib/sentry";
import { waitlistUnsubscribeUrl } from "@/lib/waitlist/unsubscribe-token";

/**
 * GET /api/cron/waitlist-notify
 *
 * The sender /api/waitlist promised: "we'll email you that day". Runs daily
 * (see vercel.json), picks every booking_waitlist row whose opens_on has
 * arrived, unsent, not unsubscribed, and sends one "it's open, go book it"
 * email each. A per-row failure is captured to Sentry and skipped — one bad
 * address must never stop the rest of the batch from sending.
 *
 * Auth: same pattern as reconcile-cancellations — Vercel injects
 * `Authorization: Bearer <CRON_SECRET>`; refuse without it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Keep one run bounded; whatever's left picks up on tomorrow's run since
// opens_on <= today only grows the backlog forward, never drops rows.
const MAX_ROWS_PER_RUN = 200;

const CTX = { endpoint: "/api/cron/waitlist-notify", method: "GET" as const };

interface WaitlistRow {
  id: string;
  email: string;
  airport_code: string;
  wanted_checkin: string;
  wanted_checkout: string | null;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const todayISO = format(new Date(), "yyyy-MM-dd");
  const supabase = await createAdminClient();

  const { data: rows, error: selectError } = await supabase
    .from("booking_waitlist")
    .select("id, email, airport_code, wanted_checkin, wanted_checkout")
    .lte("opens_on", todayISO)
    .is("notified_at", null)
    .is("unsubscribed_at", null)
    .limit(MAX_ROWS_PER_RUN);

  if (selectError) {
    captureAPIError(new Error(selectError.message), { ...CTX, stage: "select" });
    return NextResponse.json({ ok: false, error: "select failed" }, { status: 500 });
  }

  const pending = (rows ?? []) as WaitlistRow[];
  let sent = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      await sendOpensOnEmail(row);
      const { error: updateError } = await supabase
        .from("booking_waitlist")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", row.id);
      if (updateError) {
        // The email is already sent — a re-send on tomorrow's run is the
        // worse failure mode here, so this is loud but doesn't retry today.
        captureAPIError(new Error(updateError.message), {
          ...CTX,
          stage: "mark_notified",
          code: updateError.code,
        });
        failed++;
        continue;
      }
      sent++;
    } catch (error) {
      captureAPIError(error instanceof Error ? error : new Error(String(error)), {
        ...CTX,
        stage: "send",
      });
      failed++;
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: pending.length,
    sent,
    failed,
    capped: pending.length >= MAX_ROWS_PER_RUN,
  });
}

async function sendOpensOnEmail(row: WaitlistRow) {
  const airport = getAirportByCode(row.airport_code);
  const airportName = airport ? `${airport.city} (${row.airport_code})` : row.airport_code;
  const checkinDate = format(new Date(`${row.wanted_checkin}T00:00:00`), "MMMM d, yyyy");
  const unsubscribeUrl = waitlistUnsubscribeUrl(row.id);

  const searchParams = new URLSearchParams({
    airport: row.airport_code,
    checkin: row.wanted_checkin,
  });
  if (row.wanted_checkout) searchParams.set("checkout", row.wanted_checkout);
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";
  const searchUrl = `${base.replace(/\/$/, "")}/search?${searchParams.toString()}`;

  await resend.emails.send({
    from: FROM_EMAIL,
    to: [row.email],
    subject: `${row.airport_code} parking for ${format(
      new Date(`${row.wanted_checkin}T00:00:00`),
      "MMM d"
    )} is now open to book`,
    headers: { "List-Unsubscribe": `<${unsubscribeUrl}>` },
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <div style="background-color: #1A1A2E; padding: 32px 40px; text-align: center;">
          <h1 style="margin: 0; color: #f87356; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Triply</h1>
          <p style="margin: 4px 0 0; color: #94a3b8; font-size: 13px;">Your Trip Simplified</p>
        </div>
        <div style="padding: 40px;">
          <h2 style="margin: 0 0 20px; color: #111827; font-size: 20px; font-weight: 700;">${airportName} is open for booking</h2>
          <p style="font-size: 15px; color: #374151; line-height: 1.6;">
            You asked us to let you know when parking opened for <strong>${checkinDate}</strong>. It's here &mdash; go grab your spot before it's gone.
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${searchUrl}" style="background-color: #f87356; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block;">
              Book ${row.airport_code} Parking
            </a>
          </div>
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
