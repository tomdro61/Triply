import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { captureBookingError } from "@/lib/sentry";
import { getClaimableCustomerIds } from "@/lib/bookings/claimable";

/**
 * POST /api/user/link-bookings
 *
 * The customer's explicit "add the bookings under my email to my account"
 * action (plan B3c: recovery is confirmation-gated, never a silent write).
 * Links every UNLINKED customer row whose email matches the authenticated
 * user's VERIFIED email to that user, and records each link in
 * customer_link_audit so a bad link can be detected and reverted.
 *
 * Idempotent: re-invoking after everything is linked returns { linked: 0 }.
 * Behind the ENABLE_EMAIL_BOOKING_FALLBACK kill-switch. (This same endpoint is
 * the intended hook for the later login-time backfill.)
 */
export async function POST() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Kill-switch — lets ops halt all email-based linking via a Vercel env
    // change + redeploy, with no code revert.
    if (process.env.ENABLE_EMAIL_BOOKING_FALLBACK === "false") {
      return NextResponse.json({ linked: 0, disabled: true });
    }

    // Only a proven mailbox may claim bookings by email.
    if (!user.email || !user.email_confirmed_at) {
      return NextResponse.json({ linked: 0 });
    }

    const emailLc = user.email.toLowerCase();
    const admin = await createAdminClient();

    // Candidate unlinked customer rows matching the verified email (shared,
    // case-insensitive, wildcard-safe matcher — same filter as /api/user/bookings).
    let candidateIds: string[];
    try {
      candidateIds = await getClaimableCustomerIds(admin, user.email);
    } catch (lookupError) {
      captureBookingError(
        lookupError instanceof Error ? lookupError : new Error(String(lookupError)),
        { step: "account", userId: user.id }
      );
      return NextResponse.json({ error: "Failed to link bookings" }, { status: 500 });
    }

    if (candidateIds.length === 0) {
      return NextResponse.json({ linked: 0 });
    }

    // Link, guarded on user_id IS NULL so a concurrent claim can't double-write
    // or clobber a row linked in the meantime. .select() returns the rows we
    // ACTUALLY updated, so the audit reflects reality.
    const { data: updated, error: updateError } = await admin
      .from("customers")
      .update({ user_id: user.id })
      .in("id", candidateIds)
      .is("user_id", null)
      .select("id");

    if (updateError) {
      captureBookingError(
        new Error(`link-bookings update failed: ${updateError.message}`),
        { step: "account", userId: user.id }
      );
      return NextResponse.json({ error: "Failed to link bookings" }, { status: 500 });
    }

    const linkedIds = (updated ?? []).map((r) => r.id);

    if (linkedIds.length > 0) {
      const { error: auditError } = await admin.from("customer_link_audit").insert(
        linkedIds.map((cid) => ({
          customer_id: cid,
          old_user_id: null,
          new_user_id: user.id,
          matched_email: emailLc,
          source: "claim",
        }))
      );
      if (auditError) {
        // The link succeeded but the audit breadcrumb didn't — surface loudly.
        // The link is still valid; we've only lost the easy-revert record for
        // these ids, which ops can reconstruct from user_id + matched email.
        captureBookingError(
          new Error(
            `link-bookings audit insert failed for [${linkedIds.join(",")}]: ${auditError.message}`
          ),
          { step: "account", userId: user.id }
        );
      }
    }

    return NextResponse.json({ linked: linkedIds.length });
  } catch (error) {
    console.error("Error in link-bookings route:", error);
    captureBookingError(error instanceof Error ? error : new Error(String(error)), {
      step: "account",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
