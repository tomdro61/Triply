import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { z } from "zod";

const profileSchema = z.object({
  firstName: z.string().max(100).trim().optional(),
  lastName: z.string().max(100).trim().optional(),
  phone: z.string().max(20).trim().optional(),
});

// GET user profile
export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get customer record if exists. Tolerate-multiple (a user can currently
    // have >1 customer row until Phase 5 dedup) via order+limit+maybeSingle so
    // this never throws on duplicates. A real DB error must surface as 500 —
    // returning customer:null on an error would render a blank profile as if
    // the customer simply had no record.
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (customerError) {
      captureAPIError(
        new Error(`profile customer lookup failed: ${customerError.message}`),
        { endpoint: "/api/user/profile", method: "GET" }
      );
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.user_metadata?.full_name || user.user_metadata?.name || "",
        avatarUrl: user.user_metadata?.avatar_url || user.user_metadata?.picture || "",
        provider: user.app_metadata?.provider || "email",
        createdAt: user.created_at,
      },
      customer: customer
        ? {
            firstName: customer.first_name,
            lastName: customer.last_name,
            phone: customer.phone,
          }
        : null,
    });
  } catch (error) {
    console.error("Error fetching user profile:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/user/profile",
      method: "GET",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// UPDATE user profile
export async function PUT(request: NextRequest) {
  try {
    const supabase = await createClient();
    const adminSupabase = await createAdminClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const validation = profileSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: "Invalid profile data", fields: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { firstName, lastName, phone } = validation.data;

    // Update or create customer record. Tolerate-multiple (a user can have >1
    // customer row until Phase 5 dedup) via order+limit+maybeSingle — .single()
    // errors on duplicate rows, which would silently fall through to the INSERT
    // branch and mint a THIRD duplicate (or hit a unique violation). Surface a
    // real DB error as 500 instead of ignoring it.
    const { data: existingCustomer, error: lookupError } = await adminSupabase
      .from("customers")
      .select("id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (lookupError) {
      captureAPIError(
        new Error(`profile customer lookup (PUT) failed: ${lookupError.message}`),
        { endpoint: "/api/user/profile", method: "PUT" }
      );
      return NextResponse.json(
        { error: "Failed to update profile" },
        { status: 500 }
      );
    }

    if (existingCustomer) {
      // Update existing customer
      const { error: updateError } = await adminSupabase
        .from("customers")
        .update({
          first_name: firstName,
          last_name: lastName,
          phone: phone,
        })
        .eq("id", existingCustomer.id);

      if (updateError) {
        console.error("Error updating customer:", updateError);
        return NextResponse.json(
          { error: "Failed to update profile" },
          { status: 500 }
        );
      }
    } else {
      // Create new customer record
      const { error: insertError } = await adminSupabase
        .from("customers")
        .insert({
          user_id: user.id,
          email: user.email!,
          first_name: firstName,
          last_name: lastName,
          phone: phone,
        });

      if (insertError) {
        console.error("Error creating customer:", insertError);
        return NextResponse.json(
          { error: "Failed to create profile" },
          { status: 500 }
        );
      }
    }

    // Update Supabase auth user metadata with full name
    const fullName = `${firstName} ${lastName}`.trim();
    if (fullName) {
      await supabase.auth.updateUser({
        data: { full_name: fullName },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating user profile:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/user/profile",
      method: "PUT",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
