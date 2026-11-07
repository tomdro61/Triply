import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { captureAPIError } from "@/lib/sentry";
import { lookupPromoRule } from "@/lib/promo/lookup";

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

/**
 * Whether a code is usable, and its RULE — not a discount: there is no cart
 * here. The checkout applies the rule to its own prices (promoDiscountCents),
 * and POST /api/checkout/lot applies it again to the server's fresh price,
 * which is the one that is charged.
 *
 *   200 { valid: true, code, kind: "percent" | "fixed", discountPercent,
 *         discountCents, minSubtotalCents }
 *       discountPercent is null for a fixed code and discountCents null for a
 *       percent one. Checkout pages loaded before PR 2 still read
 *       discountPercent at Apply, but their checkout POST is refused as a stale
 *       page before any payment (no promo-pricing header), so a figure they misread is
 *       never charged.
 *   200 { valid: false, error, reason }   unknown / inactive / expired / used up /
 *       not available (a fixed code while PROMO_FIXED_ENABLED is off)
 *   503 the lookup failed — try again
 */
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

    const lookup = await lookupPromoRule(result.data.code, { endpoint: "/api/promo/validate", method: "POST" });
    if (lookup.kind === "unavailable") {
      return NextResponse.json(
        { valid: false, error: LOOKUP_UNAVAILABLE_MESSAGE },
        { status: 503 }
      );
    }
    if (lookup.kind === "refused") {
      return NextResponse.json({ valid: false, error: lookup.message, reason: lookup.reason });
    }

    const { rule } = lookup;
    return NextResponse.json({
      valid: true,
      code: rule.code,
      kind: rule.amountCents !== null ? "fixed" : "percent",
      discountPercent: rule.percent,
      discountCents: rule.amountCents,
      minSubtotalCents: rule.minSubtotalCents,
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
