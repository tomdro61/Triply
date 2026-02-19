import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";
import { z } from "zod";

const updatePartnerSchema = z.object({
  is_active: z.boolean().optional(),
  company_name: z.string().optional(),
  location_name: z.string().min(1).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isAdminEmail(user.email)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json();
    const parsed = updatePartnerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = await createAdminClient();
    const { data: partner, error } = await supabase
      .from("partners")
      .update(parsed.data)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("Update partner error:", error);
      return NextResponse.json(
        { error: "Failed to update partner" },
        { status: 500 }
      );
    }

    return NextResponse.json({ partner });
  } catch (error) {
    console.error("Update partner error:", error);
    captureAPIError(
      error instanceof Error ? error : new Error(String(error)),
      { endpoint: "/api/admin/partners/[id]", method: "PATCH" }
    );
    return NextResponse.json(
      { error: "Failed to update partner" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isAdminEmail(user.email)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const supabase = await createAdminClient();

    // Get partner to find user_id
    const { data: partner, error: fetchError } = await supabase
      .from("partners")
      .select("user_id")
      .eq("id", id)
      .single();

    if (fetchError || !partner) {
      return NextResponse.json(
        { error: "Partner not found" },
        { status: 404 }
      );
    }

    // Delete partner record
    const { error: deleteError } = await supabase
      .from("partners")
      .delete()
      .eq("id", id);

    if (deleteError) {
      console.error("Delete partner error:", deleteError);
      return NextResponse.json(
        { error: "Failed to delete partner" },
        { status: 500 }
      );
    }

    // Delete auth user
    const { error: authDeleteError } =
      await supabase.auth.admin.deleteUser(partner.user_id);

    if (authDeleteError) {
      console.error("Delete partner auth user error:", authDeleteError);
      // Partner record already deleted, log but don't fail
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete partner error:", error);
    captureAPIError(
      error instanceof Error ? error : new Error(String(error)),
      { endpoint: "/api/admin/partners/[id]", method: "DELETE" }
    );
    return NextResponse.json(
      { error: "Failed to delete partner" },
      { status: 500 }
    );
  }
}
