/**
 * GET /api/admin/disputes — the dispute ledger (migration 045/046) for
 * /admin/disputes, plus Radar early fraud warnings.
 *
 * `?mode=live|test|all`. With no mode it shows the deployment's own Stripe
 * mode (as /api/admin/bookings, PR #88): staging and production share one
 * database, so a staging admin must not land on production's live disputes.
 * The mode applied is returned.
 *
 * EVERY open dispute is returned (nearest deadline first) — a newest-N cap
 * could push an old open dispute off the page. Only closed history is capped;
 * the won/lost totals are counted, never taken from the capped list.
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
      warnings = warnings.eq("livemode", live);
    }

    const [o, c, won, lost, w] = await Promise.all([open, closed, wonCount, lostCount, warnings]);
    for (const [label, r] of [["open disputes", o], ["closed disputes", c], ["won count", won], ["lost count", lost]] as const) {
      if (r.error) throw new Error(`${label}: ${r.error.message}`);
    }
    // A count that came back empty is unknown, not zero.
    if (won.count == null || lost.count == null) throw new Error("won/lost counts missing");
    // Warnings are secondary: a failed warnings read is shown as unavailable
    // on the page, never as zero, and doesn't hide the disputes.
    const warningError = w.error ? w.error.message : null;
    if (w.error) captureAPIError(new Error(`fraud_warnings: ${w.error.message}`), { endpoint: "/api/admin/disputes", method: "GET" });

    return NextResponse.json({
      mode,
      open: o.data ?? [],
      closed: c.data ?? [],
      closedShown: CLOSED_SHOWN,
      counts: { won: won.count, lost: lost.count },
      warnings: w.data ?? [],
      warningError,
    });
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), { endpoint: "/api/admin/disputes", method: "GET" });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load disputes" }, { status: 500 });
  }
}
