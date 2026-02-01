import { NextRequest, NextResponse } from "next/server";
import { createPaymentIntent } from "@/lib/stripe/client";

interface CreatePaymentIntentBody {
  amount: number;
  lotName: string;
  lotId: string;
  checkIn: string;
  checkOut: string;
  customerEmail: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: CreatePaymentIntentBody = await request.json();

    const { amount, lotName, lotId, checkIn, checkOut, customerEmail } = body;

    // Validate required fields
    if (!amount || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid payment amount" },
        { status: 400 }
      );
    }

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
