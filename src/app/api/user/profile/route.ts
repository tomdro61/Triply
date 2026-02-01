import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";

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

    // Get customer record if exists
    const { data: customer } = await supabase
      .from("customers")
      .select("*")
      .eq("user_id", user.id)
      .single();

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
    const { firstName, lastName, phone } = body;

    // Update or create customer record
    const { data: existingCustomer } = await adminSupabase
      .from("customers")
      .select("id")
      .eq("user_id", user.id)
      .single();

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
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
