import { NextRequest, NextResponse } from "next/server";
import { getLotById } from "@/lib/data/mock-lots";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Find lot by ID or slug
  const lot = getLotById(id);

  if (!lot) {
    return NextResponse.json({ error: "Lot not found" }, { status: 404 });
  }

  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 200));

  return NextResponse.json(lot);
}
