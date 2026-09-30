import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";

export async function GET(request: NextRequest) {
  try {
    // Auth check
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isAdminEmail(user.email)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const supabase = await createAdminClient();

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20") || 20));
    const status = searchParams.get("status");
    const search = searchParams.get("search");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const offset = (page - 1) * limit;

    // Build query
    let query = supabase
      .from("bookings")
      .select(`
        *,
        customers (
          id,
          email,
          first_name,
          last_name,
          phone
        )
      `, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    // Filter by status
    if (status && status !== "all") {
      query = query.eq("status", status);
    }

    // Filter by date range
    if (startDate) {
      query = query.gte("created_at", startDate);
    }
    if (endDate) {
      query = query.lt("created_at", endDate);
    }

    // Search by reservation number or location name
    if (search) {
      const sanitizedSearch = search.replace(/[^a-zA-Z0-9\s\-_#]/g, "");
      if (sanitizedSearch) {
        query = query.or(`reslab_reservation_number.ilike.%${sanitizedSearch}%,location_name.ilike.%${sanitizedSearch}%`);
      }
    }

    const { data: bookings, error, count } = await query;

    if (error) {
      console.error("Admin bookings error:", error);
      return NextResponse.json(
        { error: "Failed to fetch bookings" },
        { status: 500 }
      );
    }

    // Staff-only cancellation notes (migration 032) live in their own
    // service-role-only table, not on bookings. Attach them as
    // `cancellation_note` so the page reads one shape. A separate best-effort
    // query rather than an embed: an embed on a table that isn't there yet
    // (032 not applied) would take the whole bookings list down, whereas this
    // only loses the notes and reports to Sentry.
    const rows: Array<Record<string, unknown>> = (bookings ?? []) as Array<Record<string, unknown>>;
    const notes = new Map<string, string>();
    const ids = rows.map((b) => b.id).filter((id): id is string => typeof id === "string");
    if (ids.length > 0) {
      const { data: noteRows, error: noteError } = await supabase
        .from("booking_cancellation_notes")
        .select("booking_id, note")
        .in("booking_id", ids)
        // Bounded: a slow notes lookup must not hold up the bookings list.
        .abortSignal(AbortSignal.timeout(3_000));
      if (noteError) {
        captureAPIError(
          new Error(`Admin bookings: cancellation notes fetch failed: ${noteError.message}`),
          { endpoint: "/api/admin/bookings", method: "GET" }
        );
      } else {
        for (const n of (noteRows ?? []) as Array<{ booking_id: string; note: string }>) {
          notes.set(n.booking_id, n.note);
        }
      }
    }

    return NextResponse.json({
      bookings: rows.map((b) => ({
        ...b,
        cancellation_note: notes.get(String(b.id)) ?? null,
      })),
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (error) {
    console.error("Admin bookings error:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/admin/bookings",
      method: "GET",
    });
    return NextResponse.json(
      { error: "Failed to fetch bookings" },
      { status: 500 }
    );
  }
}
