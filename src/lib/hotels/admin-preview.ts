/**
 * Who may see Park & Stay while it is a private preview (plan §20.1).
 *
 * ResLab will not add the hotel lots to our staging channel, so the preview
 * runs in PRODUCTION (real lots) and only signed-in admins see it: a session
 * whose email is CONFIRMED and on the /admin allowlist. Everyone else gets
 * the same 404 as when the flag is off.
 *
 * Fails CLOSED: no session, an unconfirmed email, an auth error or a timeout
 * all answer false. An error or timeout is reported, at most once per 10
 * minutes per process. There is deliberately no "public" setting — opening
 * Park & Stay to customers is a launch PR that removes this gate, so no env
 * value can open it by mistake.
 *
 * Supabase Auth resolves `{ error }` and does not throw, so `error` is checked
 * as well as the catch.
 */

import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";
import { isSessionMissing } from "@/lib/booking/customer-link";
import { bounded } from "@/lib/utils/bounded";

export const PARK_STAY_VIEWER_TIMEOUT_MS = 4000;

/** At most one Sentry event per warm process per window, so a later outage is still heard. */
export const PARK_STAY_VIEWER_REPORT_INTERVAL_MS = 10 * 60 * 1000;
let lastReportAt: number | null = null;

function report(err: Error, caller: string): void {
  const now = Date.now();
  if (lastReportAt !== null && now - lastReportAt < PARK_STAY_VIEWER_REPORT_INTERVAL_MS) return;
  lastReportAt = now;
  captureAPIError(err, { endpoint: caller, method: "GET", stage: "viewer_auth" });
}

export async function parkStayViewerAllowed(caller: string): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await bounded(supabase.auth.getUser(), PARK_STAY_VIEWER_TIMEOUT_MS, "auth.getUser");
    if (error) {
      if (!isSessionMissing(error)) {
        report(new Error(`auth.getUser failed (${error.status ?? "?"}): ${error.message}`), caller);
      }
      return false;
    }
    if (!user || !user.email_confirmed_at) return false;
    return isAdminEmail(user.email);
  } catch (err) {
    report(err instanceof Error ? err : new Error(String(err)), caller);
    return false;
  }
}

/** Test seam. */
export function __resetParkStayViewerForTests(): void {
  lastReportAt = null;
}
