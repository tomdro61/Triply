import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";
import { calendarDayIn, DIGEST_TZ } from "@/lib/digest/window";
import { collectContent, collectFunnel, collectSearchTrend, collectSources } from "@/lib/admin/analytics/collect";

/**
 * GET /api/admin/analytics — the admin Analytics page (plan v2 Part B):
 * blog content, checkout funnel, booking rate by source (GA4) and the Google
 * search trend (Search Console). Each section is independent; a failed one is
 * { ok: false, error } and reported to Sentry, never shown as zero.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminEmail(user.email)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const now = new Date();
  const today = calendarDayIn(DIGEST_TZ, now);
  const [content, funnel, sources, search] = await Promise.all([
    collectContent(now, today),
    collectFunnel(now),
    collectSources(now),
    collectSearchTrend(today),
  ]);

  for (const [name, s] of [
    ["content", content],
    ["funnel", funnel],
    ["sources", sources],
    ["search", search],
  ] as const) {
    if (!s.ok) {
      captureAPIError(new Error(`admin analytics: ${name} unavailable: ${s.error}`), {
        endpoint: "/api/admin/analytics",
        method: "GET",
        stage: name,
      });
    }
  }

  return NextResponse.json({ content, funnel, sources, search }, { headers: { "Cache-Control": "no-store" } });
}
