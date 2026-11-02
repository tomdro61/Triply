import { captureAPIError } from "@/lib/sentry";

/**
 * A 2xx Park & Stay answer the page's strict shape check refused. The page
 * shows "unavailable" with Try again; this makes sure the reason is visible
 * (console + Sentry) instead of looking like an unexplained outage.
 */
export function reportRejectedAnswer(endpoint: string, status: number): void {
  console.warn(`[park-stay] ${endpoint} answer rejected by the shape check (HTTP ${status})`);
  captureAPIError(new Error(`Park & Stay answer failed the shape check: ${endpoint}`), {
    endpoint,
    method: "GET",
    statusCode: status,
    stage: "client_shape_check",
  });
}
