import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPartnerByUserId } from "@/config/partner";

export async function GET() {
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const partner = await getPartnerByUserId(user.id);
  if (!partner) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(partner);
}
