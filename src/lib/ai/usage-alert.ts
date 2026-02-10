/**
 * Anomaly detection for AI chat usage.
 *
 * Compares today's chat session count to the trailing 7-day average.
 * If today exceeds 2x the average, sends an alert email to admin.
 * Fires at most once per day (tracked via in-memory flag).
 *
 * Called non-blocking (fire-and-forget) at the end of each chat request.
 */

import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").filter(Boolean);
const THRESHOLD_MULTIPLIER = 2;

// In-memory flag to prevent duplicate alerts on the same day
let lastAlertDate: string | null = null;

export async function checkUsageAnomaly(): Promise<void> {
  try {
    const today = new Date().toISOString().split("T")[0];

    // Already alerted today
    if (lastAlertDate === today) return;

    const supabase = await createAdminClient();

    // Count today's sessions
    const { count: todayCount } = await supabase
      .from("chat_sessions")
      .select("*", { count: "exact", head: true })
      .gte("created_at", `${today}T00:00:00Z`);

    // Count last 7 days total
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const { count: weekCount } = await supabase
      .from("chat_sessions")
      .select("*", { count: "exact", head: true })
      .gte("created_at", `${sevenDaysAgo}T00:00:00Z`)
      .lt("created_at", `${today}T00:00:00Z`);

    const dailyAverage = (weekCount || 0) / 7;
    const currentCount = todayCount || 0;

    // Only alert if there's meaningful volume and it exceeds 2x average
    if (dailyAverage > 0 && currentCount > dailyAverage * THRESHOLD_MULTIPLIER) {
      lastAlertDate = today;

      if (ADMIN_EMAILS.length > 0) {
        await resend.emails.send({
          from: FROM_EMAIL,
          to: ADMIN_EMAILS,
          subject: `[Triply] AI Chat Usage Alert — ${currentCount} sessions today`,
          html: `
            <h2>AI Chat Usage Anomaly Detected</h2>
            <p><strong>Today's sessions:</strong> ${currentCount}</p>
            <p><strong>7-day daily average:</strong> ${dailyAverage.toFixed(1)}</p>
            <p><strong>Threshold:</strong> ${(dailyAverage * THRESHOLD_MULTIPLIER).toFixed(1)} (2x average)</p>
            <p>This may indicate increased traffic, abuse, or a bot. Check the <code>chat_sessions</code> table in Supabase for details.</p>
          `,
        });
      }
    }
  } catch {
    // Non-blocking — swallow errors silently
  }
}
