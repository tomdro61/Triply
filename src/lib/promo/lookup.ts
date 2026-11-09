/**
 * The ONE server-side promo-code lookup, shared by /api/promo/validate (the
 * Apply button) and POST /api/checkout/lot (the PaymentIntent), so the two can
 * never disagree on whether a code exists, is usable, or is available
 * (promo plan notes/2026-11-06-promo-fixed-amount-plan.md, Part 2).
 *
 *   rule         the code is usable: its parsed rule (percent OR fixed amount)
 *   refused      a verdict on the code — unknown, inactive, expired, used up,
 *                or not available (a fixed code while PROMO_FIXED_ENABLED is
 *                off, or a malformed row, which is also reported)
 *   unavailable  the lookup itself failed — NOT a verdict on the code. Callers
 *                answer 503; checkout creates no PaymentIntent (it used to
 *                charge full price silently).
 *
 * The discount itself is NOT computed here: that needs a cart, and only
 * promoDiscountCents (discount.ts) prices one.
 */
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { isMisconfiguredDbError } from "@/lib/supabase/error-codes";
import { captureAPIError } from "@/lib/sentry";
import { normalisePromoCode, parsePromoRule, type PromoRule } from "./discount";
import { isFixedPromoEnabled } from "./flag";
import { isPromoCodeUsable } from "./usable";

export type PromoCodeRefusal = "unknown" | "inactive" | "expired" | "used_up" | "not_available";

export type PromoLookup =
  | { kind: "rule"; rule: PromoRule }
  | { kind: "refused"; reason: PromoCodeRefusal; message: string }
  | { kind: "unavailable" };

/** What the customer reads for each refusal (today's validate wording, plus "not available"). */
export const PROMO_REFUSAL_MESSAGES: Record<PromoCodeRefusal, string> = {
  unknown: "Invalid promo code",
  inactive: "This promo code is no longer active",
  expired: "This promo code has expired",
  used_up: "This promo code has reached its usage limit",
  not_available: "This promo code isn't available right now",
};

const PROMO_SELECT = "code, discount_percent, discount_amount, min_subtotal, active, expires_at, max_uses, current_uses";
/** The TRIPLY-40 cold-start bound; two attempts (8 s) fit the checkout POST's 60 s. */
const PROMO_LOOKUP_ATTEMPT_MS = 4_000;

// One recovered-retry warning per instance per 5 minutes; the suppressed
// count rides along on the next one (the direct-lot store's rule).
const RETRY_REPORT_INTERVAL_MS = 5 * 60 * 1000;
let lastRetryReportAt = 0;
let retriesSinceReport = 0;
/** Tests only: a fresh instance between cases. */
export function __resetPromoRetryReportForTests(): void {
  lastRetryReportAt = 0;
  retriesSinceReport = 0;
}

function reportRecoveredRetry(first: string, context: { endpoint: string; method: string }): void {
  const now = Date.now();
  if (now - lastRetryReportAt < RETRY_REPORT_INTERVAL_MS) {
    retriesSinceReport += 1;
    return;
  }
  lastRetryReportAt = now;
  const suppressedSinceLastCapture = retriesSinceReport;
  retriesSinceReport = 0;
  captureAPIError(new Error(`Promo code lookup: first read failed, retry recovered — ${first}`), {
    endpoint: context.endpoint,
    method: context.method,
    stage: "promo_lookup_retry",
    level: "warning",
    extra: { suppressedSinceLastCapture },
  });
}

/** The usability columns, checked: the Supabase client is untyped. */
const usabilitySchema = z.object({
  active: z.boolean(),
  expires_at: z.string().nullable(),
  max_uses: z.number().int().nullable(),
  current_uses: z.number().int(),
});

const refused = (reason: PromoCodeRefusal): PromoLookup => ({ kind: "refused", reason, message: PROMO_REFUSAL_MESSAGES[reason] });

export async function lookupPromoRule(
  rawCode: string,
  context: { endpoint: string; method: string; env?: NodeJS.ProcessEnv }
): Promise<PromoLookup> {
  const code = normalisePromoCode(rawCode);
  if (code === "") return refused("unknown");

  const supabase = await createAdminClient();
  // Bounded: on the checkout POST a hung read would otherwise hold the
  // customer at Continue until the function's limit. The fetchDirectLot rule
  // (TRIPLY-40): a cold instance's first read can run out of its bound, so a
  // transient failure is retried once — a misconfiguration is not; a double
  // failure is reported naming both errors; a recovered retry still leaves one
  // throttled warning, so slow first reads can't go unseen. A timeout is a
  // failed lookup (503, try again), never "no such code".
  const read = () =>
    supabase
      .from("promo_codes")
      .select(PROMO_SELECT)
      .eq("code", code)
      .abortSignal(AbortSignal.timeout(PROMO_LOOKUP_ATTEMPT_MS))
      .maybeSingle();
  let first: string | null = null;
  let { data, error } = await read();
  if (error && !isMisconfiguredDbError(error.code)) {
    first = `${error.code || "no code"}: ${error.message}`;
    ({ data, error } = await read());
    if (!error) reportRecoveredRetry(first, context);
  }
  if (error) {
    captureAPIError(new Error(`Promo code lookup failed${first ? ` twice (first: ${first})` : ""}: ${error.message}`), {
      endpoint: context.endpoint,
      method: context.method,
      stage: "promo_lookup",
      code: error.code,
    });
    return { kind: "unavailable" };
  }
  if (!data) return refused("unknown");

  const usability = usabilitySchema.safeParse(data);
  if (!usability.success) {
    reportMalformed(code, `usability columns malformed: ${usability.error.issues.map((i) => i.path.join(".")).join(", ")}`, context);
    return refused("not_available");
  }
  const u = usability.data;
  if (!u.active) return refused("inactive");
  if (u.expires_at && new Date(u.expires_at) < new Date()) return refused("expired");
  if (u.max_uses !== null && u.current_uses >= u.max_uses) return refused("used_up");
  // The shared predicate is the authority on pass/fail; the three checks above
  // only choose the wording (see usable.ts — the copies drifted once).
  if (!isPromoCodeUsable(u)) return refused("unknown");

  const parsed = parsePromoRule(data);
  if (!parsed.ok) {
    reportMalformed(code, parsed.reason, context);
    return refused("not_available");
  }
  if (parsed.rule.amountCents !== null && !isFixedPromoEnabled(context.env)) return refused("not_available");
  return { kind: "rule", rule: parsed.rule };
}

function reportMalformed(code: string, reason: string, context: { endpoint: string; method: string }): void {
  captureAPIError(new Error(`promo code ${code} is unusable: ${reason}`), {
    endpoint: context.endpoint,
    method: context.method,
    stage: "promo_row_malformed",
  });
}
