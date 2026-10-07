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

    // Search by confirmation number, lot name, or customer identity (first
    // name / last name / email) — the same search the APB admin has. Customer
    // fields live on the joined `customers` table, which a base-table .or()
    // can't reach, so resolve matching customer ids first and OR the bookings
    // query on `customer_id` alongside the booking-level fields.
    // `warnings` is returned to the page so a failed or truncated customer
    // lookup is never indistinguishable from a genuine "no matches".
    const warnings: string[] = [];
    if (search) {
      const raw = search.trim();
      // Keep letters/digits/space/-_# plus @ and . for email. Everything else
      // (commas, parens, quotes, %) is stripped so it can't break the PostgREST
      // .or() string or widen the ILIKE with a stray wildcard.
      // Capped: the term rides in the GET URL several times; a multi-KB paste
      // would 414 the whole bookings query.
      const sanitized = raw.replace(/[^a-zA-Z0-9\s\-_#@.]/g, "").trim().slice(0, 100);
      const ors: string[] = [];
      if (sanitized) {
        ors.push(`reslab_reservation_number.ilike.%${sanitized}%`);
        ors.push(`location_name.ilike.%${sanitized}%`);

        // Cap the customer-id fan-out: `customer_id.in.(<uuid>,…)` rides in the
        // GET URL (~37 chars per id); past a few hundred it trips URL limits and
        // fails the WHOLE bookings query. 200 is ample for a real name/email.
        const CUST_CAP = 200;
        const like = `%${sanitized}%`;
        const customerIds = new Set<string>();
        const reportCustErr = (err: { message: string }, which: string) => {
          // Term length only — the term is a customer's name or email.
          captureAPIError(new Error(`${which} search failed (term length ${sanitized.length}): ${err.message}`), {
            endpoint: "/api/admin/bookings",
            method: "GET",
            stage: "customer_search",
          });
          if (!warnings.includes("customer_search_unavailable")) {
            warnings.push("customer_search_unavailable");
          }
        };

        // The term against first name, last name, OR email.
        const { data: byField, error: custErr } = await supabase
          .from("customers")
          .select("id")
          .or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like}`)
          .order("id")
          .limit(CUST_CAP);
        if (custErr) reportCustErr(custErr, "customer");
        for (const c of (byField ?? []) as Array<{ id: string }>) customerIds.add(c.id);

        // "Virginia White" matches no single column: first token vs first_name
        // AND last token vs last_name.
        const parts = sanitized.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
          const { data: byFullName, error: fullNameErr } = await supabase
            .from("customers")
            .select("id")
            .ilike("first_name", `%${parts[0]}%`)
            .ilike("last_name", `%${parts[parts.length - 1]}%`)
            .order("id")
            .limit(CUST_CAP);
          if (fullNameErr) reportCustErr(fullNameErr, "full-name");
          for (const c of (byFullName ?? []) as Array<{ id: string }>) customerIds.add(c.id);
        }

        // Truncated when EITHER leg filled its cap (the union alone can't tell
        // 150+100 unique ids from a capped leg). A broad term ("gmail") is
        // normal admin use, so this is a page notice, not a Sentry event.
        if (byField?.length === CUST_CAP || (parts.length >= 2 && customerIds.size >= CUST_CAP)) {
          warnings.push("customer_search_truncated");
        }
        if (customerIds.size > 0) {
          // The union of two capped legs can reach 2×CUST_CAP; cap the list that
          // actually goes into the URL so the bookings query itself can't 414.
          ors.push(`customer_id.in.(${[...customerIds].slice(0, CUST_CAP).join(",")})`);
        }
      }

      if (ors.length > 0) {
        query = query.or(ors.join(","));
      } else {
        // Typed something that sanitised to nothing matchable (all symbols).
        // Force an empty page rather than silently returning EVERY booking.
        query = query.eq("id", "00000000-0000-0000-0000-000000000000");
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
      // "customer_search_unavailable" | "customer_search_truncated" — the page
      // shows these so a degraded search never looks like "no matches".
      warnings,
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
