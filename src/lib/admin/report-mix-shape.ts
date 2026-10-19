import { captureAPIError } from "@/lib/sentry";

/**
 * The admin revenue charts parse their own slice of /api/admin/accounting; a
 * failed parse means the reconciler's response changed under them. The page
 * says "unavailable" — this makes sure someone also finds out why.
 */
export function reportMixShape(paths: string, page: string): void {
  captureAPIError(new Error(`Admin revenue chart: accounting response failed the chart schema at ${paths}`), {
    endpoint: "/api/admin/accounting",
    method: "GET",
    stage: "revenue-chart-parse",
    extra: { page },
  });
}
