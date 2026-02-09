import { NextRequest, NextResponse } from "next/server";
import { createPaymentIntent } from "@/lib/stripe/client";
import { paymentIntentSchema } from "@/lib/validation/schemas";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate with Zod
    const result = paymentIntentSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: result.error.issues[0].message },
        { status: 400 }
      );
    }

    const { amount, lotName, lotId, checkIn, checkOut, customerEmail } =
      result.data;

    // Create PaymentIntent with metadata
    const paymentIntent = await createPaymentIntent(amount, {
      lotName,
      lotId,
      checkIn,
      checkOut,
      customerEmail,
    });

    return NextResponse.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("Payment intent creation error:", error);

    if (error instanceof Error) {
      return NextResponse.json(
        { error: error.message || "Failed to create payment intent" },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: "Failed to create payment intent" },
      { status: 500 }
    );
  }
}
