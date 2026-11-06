/**
 * POST /api/admin/disputes/:id/submitted — records that a person submitted the
 * evidence in the Stripe dashboard. Bookkeeping only: nothing is sent to
 * Stripe (submission stays a human click there). Set once; a second call is a
 * 409 so the first submitter and time are never overwritten.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { captureAPIError } from "@/lib/sentry";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/direct/payout-admin";

const idSchema = z.string().regex(/^(dp|du)_[A-Za-z0-9]+$/);

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const id = idSchema.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Not a Stripe dispute id" }, { status: 400 });

  try {
    const supabase = await createAdminClient();
    const submittedAt = new Date().toISOString();
    const { data, error } = await supabase
      .from("disputes")
      .update({ submitted_at: submittedAt, submitted_by: gate.value.email })
      .eq("stripe_dispute_id", id.data)
      .is("submitted_at", null)
      .select("stripe_dispute_id");
    if (error) throw new Error(error.message);
    if (!Array.isArray(data) || data.length === 0) {
      const { data: row, error: readErr } = await supabase
        .from("disputes")
        .select("stripe_dispute_id")
        .eq("stripe_dispute_id", id.data)
        .maybeSingle();
      if (readErr) throw new Error(readErr.message);
      return row
        ? NextResponse.json({ error: "Already marked submitted" }, { status: 409 })
        : NextResponse.json({ error: "No such dispute" }, { status: 404 });
    }
    return NextResponse.json({ submittedAt, submittedBy: gate.value.email });
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), {
      endpoint: "/api/admin/disputes/[id]/submitted",
      method: "POST",
    });
    return NextResponse.json({ error: "Could not record the submission" }, { status: 500 });
  }
}
