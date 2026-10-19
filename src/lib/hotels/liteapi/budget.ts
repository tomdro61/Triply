/**
 * Durable daily LiteAPI call budget (migration 043; plan v3 §7.2).
 *
 * Every METERED request takes one call from today's row (UTC day × mode)
 * before it is sent. The row is shared by every instance, so it is the real
 * boundary; the per-IP limiter in attribution/limiter.ts is only a per-lambda
 * brake.
 *
 * A successful take returns a `BudgetTicket`. The Park & Stay routes take ONE
 * ticket per request before ANY supplier call (ResLab or LiteAPI) and the
 * rates call spends it (`meter: "prepaid"` in client.ts) — so a bot burst
 * that empties the budget costs no ResLab calls, and there is no double take.
 * A ticket is single-use and can only be minted here.
 *
 * Fails CLOSED: a spent budget, a database error, or no answer within
 * BUDGET_RPC_TIMEOUT_MS all refuse the call. Search is read-only, so refusing
 * costs a page that says "temporarily unavailable" — never money. Booking /
 * cancel calls are `meter: "unmetered"` so a search budget can never block a
 * cancellation.
 *
 * Sentry: refusals are reported on a ladder of the day's refusal count
 * (counted by the database, so it holds across instances) — 1, 10, 100, then
 * every 1,000 — not only the first. The first can be lost: its rpc may time
 * out after committing, local dev (Sentry disabled) shares the sandbox row,
 * a mid-day limit change, or a dropped event. A database failure is reported
 * every time (Sentry groups it into one issue).
 */

import { captureAPIError } from "@/lib/sentry";
import { createAdminClient } from "@/lib/supabase/server";
import { bounded, BoundedTimeoutError } from "@/lib/utils/bounded";
import type { LiteApiMode } from "./env";

/**
 * Metered calls per UTC day. A Park & Stay search or hotel-page view costs 1
 * (one `/hotels/rates`), so live 2,000 ≈ 2,000 uncached requests a day.
 * Placeholders until LiteAPI answers about limits (the sandbox showed
 * `x-ratelimit-limit: 5`). A code constant: setting one to 0 switches hotel
 * search off but needs a deploy — flag off + redeploy is the faster rollback.
 */
export const LITEAPI_DAILY_CALL_BUDGET: Readonly<Record<LiteApiMode, number>> = {
  live: 2_000,
  sandbox: 1_000,
};

/** Which refusal counts of the day get a Sentry event (see the header). */
export function shouldReportRefusal(denied: number): boolean {
  return denied === 1 || denied === 10 || denied === 100 || (denied > 0 && denied % 1000 === 0);
}

/** Bounded well inside the routes' maxDuration (30 s) and a search's own latency. */
export const BUDGET_RPC_TIMEOUT_MS = 2_000;

export class LiteApiBudgetError extends Error {
  constructor(
    public reason: "exhausted" | "unavailable",
    message: string
  ) {
    super(message);
    this.name = "LiteApiBudgetError";
  }
}

export interface BudgetTakeRow {
  allowed: boolean;
  calls: number;
  denied: number;
}

/** Only this module can mint a ticket: the constructor demands a symbol nobody else holds. */
const ISSUE: unique symbol = Symbol("BudgetTicket.issue");

/**
 * One call taken from today's budget, not yet spent. Pass it to a
 * `meter: "prepaid"` request; `spend()` is single-use and checks the mode.
 */
export class BudgetTicket {
  #spent = false;

  constructor(
    key: typeof ISSUE,
    readonly mode: LiteApiMode,
    readonly row: BudgetTakeRow
  ) {
    if (key !== ISSUE) throw new Error("BudgetTicket can only be issued by takeLiteApiCall");
  }

  get spent(): boolean {
    return this.#spent;
  }

  /** Called by the LiteAPI client at send time. Throws on a second spend or a mode mismatch. */
  spend(mode: LiteApiMode): void {
    if (this.#spent) throw new Error("LiteAPI budget ticket already spent — one ticket pays for one call");
    if (mode !== this.mode) throw new Error(`LiteAPI budget ticket was taken for ${this.mode}, not ${mode}`);
    this.#spent = true;
  }
}

/** The database call, injectable for tests. Resolves `{ data, error }` like supabase-js; never throws by contract. */
export type BudgetRpc = (args: { p_provider: string; p_mode: LiteApiMode; p_limit: number }) => PromiseLike<{
  data: unknown;
  error: { message: string; code?: string } | null;
}>;

const defaultRpc: BudgetRpc = async (args) => {
  const supabase = await createAdminClient();
  return supabase.rpc("supplier_call_budget_take", args);
};

function parseRow(data: unknown): BudgetTakeRow | null {
  // RETURNS TABLE → PostgREST returns an array of one row.
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.allowed !== "boolean" || typeof r.calls !== "number" || typeof r.denied !== "number") return null;
  return { allowed: r.allowed, calls: r.calls, denied: r.denied };
}

/**
 * Take one call from today's budget, or throw `LiteApiBudgetError`.
 * `caller` labels the Sentry events (the route that asked).
 */
export async function takeLiteApiCall(
  mode: LiteApiMode,
  path: string,
  rpc: BudgetRpc = defaultRpc,
  limits: Readonly<Record<LiteApiMode, number>> = LITEAPI_DAILY_CALL_BUDGET,
  caller: string = "liteapi"
): Promise<BudgetTicket> {
  const limit = limits[mode];
  let result: Awaited<ReturnType<BudgetRpc>>;
  try {
    result = await bounded(rpc({ p_provider: "liteapi", p_mode: mode, p_limit: limit }), BUDGET_RPC_TIMEOUT_MS, "supplier_call_budget_take");
  } catch (err) {
    // A timeout's outcome is UNKNOWN: the take may still commit (a call spent
    // that was never sent, or a refusal recorded unseen).
    return refuseUnavailable(err instanceof Error ? err.message : String(err), mode, path, caller, err instanceof BoundedTimeoutError);
  }
  if (result.error) {
    return refuseUnavailable(`rpc failed (${result.error.code ?? "?"}): ${result.error.message}`, mode, path, caller);
  }
  const row = parseRow(result.data);
  if (!row) {
    return refuseUnavailable(`unexpected rpc result: ${JSON.stringify(result.data)?.slice(0, 200)}`, mode, path, caller);
  }
  if (!row.allowed) {
    if (shouldReportRefusal(row.denied)) {
      // limit 0 is the deliberate off switch: say so rather than "spent".
      const what = limit <= 0 ? "switched off (limit 0)" : "spent";
      captureAPIError(new Error(`LiteAPI daily call budget ${what} (${mode}, limit ${limit})`), {
        endpoint: caller,
        method: "GET",
        stage: "budget_exhausted",
        extra: { mode, limit, calls: row.calls, denied: row.denied, path },
      });
    }
    throw new LiteApiBudgetError("exhausted", `LiteAPI daily call budget spent (${mode}: ${row.calls}/${limit})`);
  }
  return new BudgetTicket(ISSUE, mode, row);
}

function refuseUnavailable(detail: string, mode: LiteApiMode, path: string, caller: string, outcomeUnknown = false): never {
  const err = new LiteApiBudgetError("unavailable", `LiteAPI call budget unavailable: ${detail}`);
  captureAPIError(err, {
    endpoint: caller,
    method: "GET",
    stage: "budget_unavailable",
    extra: { mode, path, outcomeUnknown },
  });
  throw err;
}
