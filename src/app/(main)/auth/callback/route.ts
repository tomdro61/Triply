import { createClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/auth/safe-redirect";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  // Only a page of our own site; anything else goes to the homepage.
  const safeNext = safeRedirectPath(requestUrl.searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const destination = new URL(safeNext, requestUrl.origin);
      // Defence in depth: safeRedirectPath already returns an on-site path.
      return NextResponse.redirect(
        destination.origin === requestUrl.origin ? destination : new URL("/", requestUrl.origin)
      );
    }
  }

  // Return to login page if there's an error
  return NextResponse.redirect(new URL("/auth/login", requestUrl.origin));
}
