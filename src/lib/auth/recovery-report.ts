import { captureAPIError } from "@/lib/sentry";
import type { AuthFailure, RecoveryReport } from "./recovery";

/**
 * Sends a password-reset report to Sentry. The message is fixed text and the
 * detail is the status, code and error class only: Supabase's own message can
 * quote the email address, so it is never passed on. Each `key` is its own
 * Sentry issue, so a routine notice cannot hide a real failure in one group.
 */
export function reportRecovery(
  report: RecoveryReport | null,
  where: { endpoint: string; method: string },
  failure?: AuthFailure | null,
  extra?: Record<string, string | number | null>
): void {
  if (!report) return;
  captureAPIError(new Error(report.message), {
    endpoint: where.endpoint,
    method: where.method,
    code: failure?.code,
    fingerprint: ["password-reset", report.key],
    // `status` goes here as well as in the tag: the tag drops a 0, and a 0 is
    // how a request that got no answer is told from one with no status at all.
    extra: { status: failure?.status ?? null, name: failure?.name ?? null, ...extra },
    ...(typeof failure?.status === "number" && failure.status > 0 ? { statusCode: failure.status } : {}),
    ...(report.level ? { level: report.level } : {}),
  });
}

/** What we keep of a caught value that is not a Supabase auth error. */
export function thrownFailure(error: unknown): AuthFailure {
  return { status: 0, name: error instanceof Error ? error.name : typeof error };
}
