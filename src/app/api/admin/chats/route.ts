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
    const search = searchParams.get("search");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");

    const offset = (page - 1) * limit;

    // Build query
    let query = supabase
      .from("chat_sessions")
      .select("*", { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    // Filter by date range
    if (startDate) {
      query = query.gte("updated_at", startDate);
    }
    if (endDate) {
      query = query.lt("updated_at", endDate);
    }

    // Search by session_id or IP
    if (search) {
      const sanitizedSearch = search.replace(/[^a-zA-Z0-9\s\-_.:#]/g, "");
      if (sanitizedSearch) {
        query = query.or(`session_id.ilike.%${sanitizedSearch}%,ip_address.ilike.%${sanitizedSearch}%`);
      }
    }

    const { data: sessions, error, count } = await query;

    if (error) {
      console.error("Admin chats error:", error);
      return NextResponse.json(
        { error: "Failed to fetch chat sessions" },
        { status: 500 }
      );
    }

    // Look up user emails for sessions with user_id
    const userIds = [...new Set(
      (sessions || [])
        .map((s) => s.user_id)
        .filter(Boolean)
    )];

    let userEmails: Record<string, string> = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase.auth.admin.listUsers();
      if (users?.users) {
        for (const u of users.users) {
          if (userIds.includes(u.id) && u.email) {
            userEmails[u.id] = u.email;
          }
        }
      }
    }

    // Enrich sessions with email
    const enrichedSessions = (sessions || []).map((s) => ({
      ...s,
      user_email: s.user_id ? userEmails[s.user_id] || null : null,
    }));

    // Get stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { count: totalCount } = await supabase
      .from("chat_sessions")
      .select("*", { count: "exact", head: true });

    const { count: todayCount } = await supabase
      .from("chat_sessions")
      .select("*", { count: "exact", head: true })
      .gte("created_at", today.toISOString());

    const { count: authCount } = await supabase
      .from("chat_sessions")
      .select("*", { count: "exact", head: true })
      .not("user_id", "is", null);

    return NextResponse.json({
      sessions: enrichedSessions,
      stats: {
        total: totalCount || 0,
        today: todayCount || 0,
        authenticated: authCount || 0,
      },
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (error) {
    console.error("Admin chats error:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/admin/chats",
      method: "GET",
    });
    return NextResponse.json(
      { error: "Failed to fetch chat sessions" },
      { status: 500 }
    );
  }
}
