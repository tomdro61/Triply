import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";
import {
  SUPPORT_BOOKING_COLUMNS,
  isCancelledStatus,
  toSupportBookingDetails,
  type CancellationNote,
  type SupportBookingRow,
} from "@/lib/support/booking-details";

/**
 * GET /api/admin/support/[id]/booking — the booking a ticket is about, for the
 * ticket panel on /admin/support (ADMIN_EMAILS only).
 *
 * Found by the ticket's booking_id (set when the reservation number AND email
 * matched at submit time). With no booking_id (the email didn't match, or the
 * lookup failed then), or one whose booking is gone (reported to Sentry), it
 * tries the reservation number,
 * and the answer says whether the booking's email matches the ticket's, so the
 * page can warn "verify identity first". Nothing here reaches the customer.
 *
 * 200 { booking: details | null }. null = no reservation number on the ticket,
 * or no booking under it.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdminEmail(user.email)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) {
      return NextResponse.json({ error: "Bad ticket id" }, { status: 400 });
    }

    const db = await createAdminClient();
    const { data: ticket, error: ticketError } = await db
      .from("support_tickets")
      .select("email, reservation_number, booking_id")
      .eq("id", id)
      .maybeSingle<{ email: string; reservation_number: string | null; booking_id: string | null }>();
    if (ticketError) throw new Error(`admin support ticket read failed: ${ticketError.message}`);
    if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

    const byId = async (bookingId: string) =>
      db.from("bookings").select(SUPPORT_BOOKING_COLUMNS).eq("id", bookingId).limit(1).maybeSingle<SupportBookingRow>();
    const byNumber = async (number: string) =>
      db
        .from("bookings")
        .select(SUPPORT_BOOKING_COLUMNS)
        .eq("reslab_reservation_number", number)
        .limit(1)
        .maybeSingle<SupportBookingRow>();

    let row: SupportBookingRow | null = null;
    if (ticket.booking_id) {
      const { data, error } = await byId(ticket.booking_id);
      if (error) throw new Error(`admin support booking read failed: ${error.message}`);
      row = data;
      if (!row) {
        // The ticket points at a booking that is gone: a data problem, not a
        // normal "no booking". Report it, then try the number it was filed under.
        captureAPIError(new Error("Support ticket's linked booking no longer exists"), {
          endpoint: "/api/admin/support/[id]/booking",
          method: "GET",
          stage: "linked_booking_missing",
        });
      }
    }
    if (!row && ticket.reservation_number) {
      const { data, error } = await byNumber(ticket.reservation_number);
      if (error) throw new Error(`admin support booking read failed: ${error.message}`);
      row = data;
    }
    if (!row) return NextResponse.json({ booking: null });

    // The staff cancellation note lives in its own service-role table (migration
    // 032). A failed read is reported and shown as "unavailable", never as no note.
    let note: CancellationNote = { note: null, unavailable: false };
    if (isCancelledStatus(row.status)) {
      const { data: noteRow, error: noteError } = await db
        .from("booking_cancellation_notes")
        .select("note")
        .eq("booking_id", row.id)
        .maybeSingle<{ note: string | null }>();
      if (noteError) {
        captureAPIError(new Error(`support cancellation note read failed: ${noteError.message}`), {
          endpoint: "/api/admin/support/[id]/booking",
          method: "GET",
          stage: "cancellation_note",
        });
        note = { note: null, unavailable: true };
      } else {
        note = { note: noteRow?.note ?? null, unavailable: false };
      }
    }

    const booking = toSupportBookingDetails(row, ticket.email, note);
    if (booking.money.paidOnline === null) {
      captureAPIError(new Error("Support booking panel: paid-online figure unreadable (grand_total missing or sum negative)"), {
        endpoint: "/api/admin/support/[id]/booking",
        method: "GET",
        stage: "paid_online_unreadable",
      });
    }
    return NextResponse.json({ booking });
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/admin/support/[id]/booking",
      method: "GET",
    });
    return NextResponse.json({ error: "Failed to load the booking" }, { status: 500 });
  }
}
