import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";
import { TICKET_COLUMNS } from "@/lib/support/tickets";

/**
 * PATCH /api/admin/support/[id] — work a ticket (ADMIN_EMAILS only).
 * Body (all optional, at least one): status, assignedTo (an admin email or
 * null), notes, markReplied (stamps first_response_at once and moves a "new"
 * ticket to "waiting" — the customer has our answer, the ball is in theirs).
 * "done" stamps resolved_at; leaving "done" clears it.
 *
 * `expectedUpdatedAt` (the ticket's updated_at as the admin last loaded it)
 * makes the write conditional: if someone else saved since, nothing changes
 * and the answer is 409, so one admin's notes never silently erase another's.
 */

const patchSchema = z
  .object({
    status: z.enum(["new", "open", "waiting", "done"]).optional(),
    assignedTo: z.string().email().max(254).nullable().optional(),
    notes: z.string().max(10_000).optional(),
    markReplied: z.literal(true).optional(),
    expectedUpdatedAt: z.string().min(1).max(64),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 1, { message: "Nothing to update" });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    const parsed = patchSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
    }
    const body = parsed.data;
    if (body.assignedTo && !isAdminEmail(body.assignedTo)) {
      return NextResponse.json({ error: "Tickets can only be assigned to a team member" }, { status: 400 });
    }

    const db = await createAdminClient();
    const { data: current, error: readError } = await db
      .from("support_tickets")
      .select("status, first_response_at")
      .eq("id", id)
      .maybeSingle<{ status: string; first_response_at: string | null }>();
    if (readError) throw new Error(`admin support read failed: ${readError.message}`);
    if (!current) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

    const now = new Date().toISOString();
    const update: Record<string, string | null> = { updated_at: now };
    let status = body.status;
    if (body.markReplied) {
      if (!current.first_response_at) update.first_response_at = now;
      if (!status && current.status === "new") status = "waiting";
    }
    if (status) {
      update.status = status;
      if (status === "done" && current.status !== "done") update.resolved_at = now;
      if (status !== "done") update.resolved_at = null;
    }
    if (body.assignedTo !== undefined) update.assigned_to = body.assignedTo?.toLowerCase() ?? null;
    if (body.notes !== undefined) update.notes = body.notes;

    const { data: written, error } = await db
      .from("support_tickets")
      .update(update)
      .eq("id", id)
      .eq("updated_at", body.expectedUpdatedAt)
      .select("id");
    if (error) throw new Error(`admin support update failed: ${error.message}`);
    if (!Array.isArray(written) || written.length === 0) {
      // The ticket as it is now, so the page can show the other change (it may
      // have left the current list view) instead of re-saving over it.
      const { data: latest } = await db.from("support_tickets").select(TICKET_COLUMNS).eq("id", id).maybeSingle();
      return NextResponse.json(
        { error: "Someone else changed this ticket since you opened it. Their changes are shown; check them, then save again.", current: latest ?? null },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, updatedAt: now });
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/admin/support/[id]",
      method: "PATCH",
    });
    return NextResponse.json({ error: "Failed to update ticket" }, { status: 500 });
  }
}
