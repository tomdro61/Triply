import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";
import { z } from "zod";

const createPartnerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  companyName: z.string().optional(),
  locationName: z.string().min(1),
  reslabLocationId: z.number().int().positive(),
});

export async function GET() {
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

    const supabase = await createAdminClient();
    const { data: partners, error } = await supabase
      .from("partners")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("List partners error:", error);
      return NextResponse.json(
        { error: "Failed to fetch partners" },
        { status: 500 }
      );
    }

    return NextResponse.json({ partners: partners || [] });
  } catch (error) {
    console.error("List partners error:", error);
    captureAPIError(
      error instanceof Error ? error : new Error(String(error)),
      { endpoint: "/api/admin/partners", method: "GET" }
    );
    return NextResponse.json(
      { error: "Failed to fetch partners" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
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

    const body = await request.json();
    const parsed = createPartnerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { email, password, companyName, locationName, reslabLocationId } =
      parsed.data;

    const supabase = await createAdminClient();

    // Create auth user
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

    if (authError) {
      console.error("Create partner auth error:", authError);
      return NextResponse.json(
        { error: authError.message },
        { status: 400 }
      );
    }

    // Insert partner record
    const { data: partner, error: partnerError } = await supabase
      .from("partners")
      .insert({
        user_id: authData.user.id,
        email,
        reslab_location_id: reslabLocationId,
        location_name: locationName,
        company_name: companyName || null,
      })
      .select()
      .single();

    if (partnerError) {
      // Rollback: delete the auth user we just created
      await supabase.auth.admin.deleteUser(authData.user.id);
      console.error("Create partner record error:", partnerError);
      return NextResponse.json(
        { error: partnerError.message },
        { status: 400 }
      );
    }

    return NextResponse.json({ partner }, { status: 201 });
  } catch (error) {
    console.error("Create partner error:", error);
    captureAPIError(
      error instanceof Error ? error : new Error(String(error)),
      { endpoint: "/api/admin/partners", method: "POST" }
    );
    return NextResponse.json(
      { error: "Failed to create partner" },
      { status: 500 }
    );
  }
}
