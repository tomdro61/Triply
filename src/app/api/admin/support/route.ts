import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail, ALERT_EMAILS } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";
import { supportLivemode } from "@/lib/support/tickets";

/**
 * GET /api/admin/support — the support inbox list (ADMIN_EMAILS only).
 *   ?view=open (default: new/open/waiting) | urgent (open AND urgent) | done | all
 *   ?search= ticket number, email, name or reservation number
 *   ?page= (25 a page)
 * Open views sort urgent → high → normal, then oldest first (who's waited longest).
 * `assignees` = the team members a ticket can be given to (alert list ∩ admins),
 * read server-side because ALERT_EMAILS is not a public env var.
 *
 * Staging and production share one database: only this deployment's tickets
 * (by Stripe mode, `livemode`) are listed and counted, as admin bookings do.
 */

const TICKET_COLUMNS =
  "id, ticket_number, name, email, subject, message, reservation_number, booking_id, booking_match, priority, reasons, auto_reply_kind, auto_reply_sent, alerted_at, status, assigned_to, first_response_at, resolved_at, notes, created_at, updated_at";

const OPEN = ["new", "open", "waiting"];
const PAGE_SIZE = 25;

export async function GET(request: NextRequest) {
  try {
    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdminEmail(user.email)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const db = await createAdminClient();
    const params = new URL(request.url).searchParams;
    const view = params.get("view") ?? "open";
    if (!["open", "urgent", "done", "all"].includes(view)) {
      return NextResponse.json({ error: "Unknown view" }, { status: 400 });
    }
    const page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
    // Same allowlist idea as /api/admin/chats: only characters a ticket
    // number, email, name or reservation number can contain reach .or().
    const search = (params.get("search") ?? "").replace(/[^a-zA-Z0-9@.\-_ ]/g, "").trim();

    const livemode = supportLivemode();
    let query = db.from("support_tickets").select(TICKET_COLUMNS, { count: "exact" }).eq("livemode", livemode);
    if (view === "open") query = query.in("status", OPEN);
    if (view === "urgent") query = query.in("status", OPEN).eq("priority", "urgent");
    if (view === "done") query = query.eq("status", "done");
    if (search) {
      const or = [`email.ilike.%${search}%`, `name.ilike.%${search}%`, `reservation_number.ilike.%${search}%`];
      if (/^\d{1,12}$/.test(search)) or.push(`ticket_number.eq.${search}`);
      query = query.or(or.join(","));
    }
    // Open queues: urgent first, then who has waited longest. Closed/all: newest first.
    query =
      view === "open" || view === "urgent"
        ? query.order("priority_rank", { ascending: true }).order("created_at", { ascending: true })
        : query.order("created_at", { ascending: false });
    const from = (page - 1) * PAGE_SIZE;

    const [list, openCount, urgentCount] = await Promise.all([
      query.range(from, from + PAGE_SIZE - 1),
      db.from("support_tickets").select("id", { count: "exact", head: true }).eq("livemode", livemode).in("status", OPEN),
      db
        .from("support_tickets")
        .select("id", { count: "exact", head: true })
        .eq("livemode", livemode)
        .in("status", OPEN)
        .eq("priority", "urgent"),
    ]);
    // A failed count must not show "0 urgent": every read errors out loudly.
    const failed =
      list.error ??
      openCount.error ??
      urgentCount.error ??
      (openCount.count == null || urgentCount.count == null ? { message: "ticket counts missing" } : null);
    if (failed) {
      captureAPIError(new Error(`admin support list failed: ${failed.message}`), { endpoint: "/api/admin/support", method: "GET" });
      return NextResponse.json({ error: "Failed to load tickets" }, { status: 500 });
    }

    const total = list.count ?? 0;
    return NextResponse.json({
      tickets: list.data ?? [],
      counts: { open: openCount.count, urgent: urgentCount.count },
      livemode,
      assignees: ALERT_EMAILS.filter((e) => isAdminEmail(e)),
      pagination: { page, limit: PAGE_SIZE, total, totalPages: Math.ceil(total / PAGE_SIZE) },
    });
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), { endpoint: "/api/admin/support", method: "GET" });
    return NextResponse.json({ error: "Failed to load tickets" }, { status: 500 });
  }
}
