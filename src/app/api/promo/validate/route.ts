import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { z } from "zod";
import { captureAPIError } from "@/lib/sentry";
import { isPromoCodeUsable } from "@/lib/promo/usable";

// A lookup fault is not a verdict on the code. Pass-4 review: this route used
// to answer a connection reset with 200 "Invalid promo code" and report
// nothing, so a Supabase blip told every customer at checkout that their valid
// code was bad — indistinguishable, to them and to us, from a genuinely
// unknown code.
const LOOKUP_UNAVAILABLE_MESSAGE =
  "We couldn't check that code right now. Please try again in a moment.";

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

    // Same rule as /api/checkout/lot and /api/newsletter: only PGRST116 (no
    // row) means "no such code". Anything else is a real fault and must
    // surface as one.
    if (error && error.code !== "PGRST116") {
      console.error("Promo code lookup failed:", error.message);
      captureAPIError(new Error(`Promo code lookup failed: ${error.message}`), {
        endpoint: "/api/promo/validate",
        method: "POST",
        stage: "lookup",
        code: error.code,
      });
      return NextResponse.json(
        { valid: false, error: LOOKUP_UNAVAILABLE_MESSAGE },
        { status: 503 }
      );
    }

    if (!promo) {
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

    // Defense in depth: the three checks above are drift-prone copies of this
    // same logic — this route disagreed with checkout/newsletter about how to
    // read a null max_uses/expires_at once already (see
    // src/lib/promo/usable.ts). The shared predicate is the actual authority
    // on pass/fail; a code that fails it despite clearing every check above
    // (only possible if this route's copy has drifted from the shared one)
    // must still be rejected, not treated as valid.
    if (!isPromoCodeUsable(promo)) {
      return NextResponse.json({ valid: false, error: "Invalid promo code" });
    }

    return NextResponse.json({
      valid: true,
      discountPercent: promo.discount_percent,
    });
  } catch (error) {
    console.error("Promo validation error:", error);
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      endpoint: "/api/promo/validate",
      method: "POST",
    });
    return NextResponse.json(
      { valid: false, error: "Failed to validate promo code" },
      { status: 500 }
    );
  }
}
