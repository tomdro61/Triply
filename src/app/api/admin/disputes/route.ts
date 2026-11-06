/**
 * GET /api/admin/disputes — the dispute ledger (migration 045/046) for
 * /admin/disputes, plus Radar early fraud warnings.
 *
 * `?mode=live|test|all`. With no mode it shows the deployment's own Stripe
 * mode (as /api/admin/bookings, PR #88): staging and production share one
 * database, so a staging admin must not land on production's live disputes.
 * The mode applied is returned.
 *
 * Open disputes come nearest deadline first, with no newest-N cap (that could
 * push an old open dispute off the page). PostgREST still caps a response at
 * 1,000 rows, so every total (open, won, lost, fraud warnings) is an exact
 * count, and the page says when a list is shorter than its count.
 *
 * Migration 046 must be applied first: the disputes select reads its
 * submitted_at / submitted_by columns.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { captureAPIError } from "@/lib/sentry";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/direct/payout-admin";
import { stripeKeyMode } from "@/lib/cancellation/source-guard";

const modeSchema = z.enum(["live", "test", "all"]);
const CLOSED_SHOWN = 100;
const DISPUTE_SELECT =
  "stripe_dispute_id, booking_id, amount_cents, currency, reason, status, evidence_due_by, livemode, evidence_drafted_at, evidence_draft_error, outcome, closed_at, submitted_at, submitted_by, created_at, bookings(reslab_reservation_number, location_name, check_in)";

export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const modeParam = request.nextUrl.searchParams.get("mode");
  const parsed = modeParam === null ? null : modeSchema.safeParse(modeParam);
  if (parsed && !parsed.success) return NextResponse.json({ error: "mode must be one of: live, test, all" }, { status: 400 });
  let mode: z.infer<typeof modeSchema>;
  if (parsed?.success) {
    mode = parsed.data;
  } else {
    const keyMode = stripeKeyMode();
    mode = keyMode ?? "all";
    if (!keyMode) {
      captureAPIError(new Error("Admin disputes: STRIPE_SECRET_KEY is missing or not a Stripe secret key — showing live + test"), {
        endpoint: "/api/admin/disputes",
        method: "GET",
      });
    }
  }

  try {
    const supabase = await createAdminClient();
    const filtered = mode !== "all";
    const live = mode === "live";

    let open = supabase
      .from("disputes")
      .select(DISPUTE_SELECT)
      .is("closed_at", null)
      .order("evidence_due_by", { ascending: true, nullsFirst: true });
    let closed = supabase
      .from("disputes")
      .select(DISPUTE_SELECT)
      .not("closed_at", "is", null)
      .order("closed_at", { ascending: false })
      .limit(CLOSED_SHOWN);
    let wonCount = supabase.from("disputes").select("stripe_dispute_id", { count: "exact", head: true }).eq("outcome", "won");
    let lostCount = supabase.from("disputes").select("stripe_dispute_id", { count: "exact", head: true }).eq("outcome", "lost");
    let openCount = supabase.from("disputes").select("stripe_dispute_id", { count: "exact", head: true }).is("closed_at", null);
    let warningsCount = supabase.from("fraud_warnings").select("stripe_warning_id", { count: "exact", head: true });
    let warnings = supabase
      .from("fraud_warnings")
      .select("stripe_warning_id, charge_id, booking_id, fraud_type, actionable, livemode, created_at, bookings(reslab_reservation_number, status)")
      .order("created_at", { ascending: false })
      .limit(50);
    if (filtered) {
      open = open.eq("livemode", live);
      closed = closed.eq("livemode", live);
      wonCount = wonCount.eq("livemode", live);
      lostCount = lostCount.eq("livemode", live);
      openCount = openCount.eq("livemode", live);
      warningsCount = warningsCount.eq("livemode", live);
      warnings = warnings.eq("livemode", live);
    }

    const [o, c, won, lost, openN, w, wN] = await Promise.all([open, closed, wonCount, lostCount, openCount, warnings, warningsCount]);
    for (const [label, r] of [["open disputes", o], ["closed disputes", c], ["won count", won], ["lost count", lost], ["open count", openN]] as const) {
      if (r.error) throw new Error(`${label}: ${r.error.message}`);
    }
    // A count that came back empty is unknown, not zero.
    if (won.count == null || lost.count == null || openN.count == null) throw new Error("dispute counts missing");
    // Warnings are secondary: a failed warnings read is shown as unavailable
    // on the page, never as zero, and doesn't hide the disputes.
    const warnErr = w.error ?? wN.error ?? (wN.count == null ? { message: "fraud warning count missing" } : null);
    const warningError = warnErr ? warnErr.message : null;
    if (warnErr) captureAPIError(new Error(`fraud_warnings: ${warnErr.message}`), { endpoint: "/api/admin/disputes", method: "GET" });

    return NextResponse.json({
      mode,
      open: o.data ?? [],
      closed: c.data ?? [],
      closedShown: CLOSED_SHOWN,
      counts: { open: openN.count, won: won.count, lost: lost.count, warnings: warnErr ? null : wN.count },
      warnings: w.data ?? [],
      warningError,
    });
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), { endpoint: "/api/admin/disputes", method: "GET" });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load disputes" }, { status: 500 });
  }
}
