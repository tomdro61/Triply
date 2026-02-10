import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";

const promoValidateSchema = z.object({
  code: z.string().min(1).max(50),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = promoValidateSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { valid: false, error: "Invalid request" },
        { status: 400 }
      );
    }

    const { code } = result.data;
    const supabase = await createAdminClient();

    const { data: promo, error } = await supabase
      .from("promo_codes")
      .select("id, code, discount_percent, active, expires_at, max_uses, current_uses")
      .eq("code", code.toUpperCase())
      .single();

    if (error || !promo) {
      return NextResponse.json({ valid: false, error: "Invalid promo code" });
    }

    if (!promo.active) {
      return NextResponse.json({ valid: false, error: "This promo code is no longer active" });
    }

    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return NextResponse.json({ valid: false, error: "This promo code has expired" });
    }

    if (promo.max_uses !== null && promo.current_uses >= promo.max_uses) {
      return NextResponse.json({ valid: false, error: "This promo code has reached its usage limit" });
    }

    return NextResponse.json({
      valid: true,
      discountPercent: promo.discount_percent,
    });
  } catch (error) {
    console.error("Promo validation error:", error);
    return NextResponse.json(
      { valid: false, error: "Failed to validate promo code" },
      { status: 500 }
    );
  }
}
