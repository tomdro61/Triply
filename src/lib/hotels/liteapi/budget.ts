/**
 * Durable daily LiteAPI call budget (plan v2 §5; migration 043).
 *
 * Every METERED request takes one call from today's row (UTC day × mode)
 * before it is sent. The row is shared by every instance, so it is the real
 * boundary; the per-IP limiter in attribution/limiter.ts is only a per-lambda
 * brake.
 *
 * Fails CLOSED: a spent budget, a database error, or no answer within
 * BUDGET_RPC_TIMEOUT_MS all refuse the call. Search is read-only, so refusing
 * costs a hotel tab that says "temporarily unavailable" — never money. Only
 * search is metered; booking / cancel calls are `meter: "unmetered"` so a
 * search budget can never block a cancellation.
 *
 * Sentry: one event on the FIRST refusal of the day per mode (`denied === 1`,
 * counted by the database, so it holds across instances); a database failure
 * is reported every time (Sentry groups it into one issue).
 */

import { captureAPIError } from "@/lib/sentry";
import { createAdminClient } from "@/lib/supabase/server";
import { bounded } from "@/lib/utils/bounded";
import type { LiteApiMode } from "./env";

/**
 * Metered calls per UTC day. A park-stay search costs 2 (hotel list + rates),
 * so live 2,000 ≈ 1,000 uncached searches a day. Placeholders until LiteAPI
 * answers Q11 (documented limits, look-to-book) — set either to 0 to switch
 * hotel search off without a flag change.
 */
export const LITEAPI_DAILY_CALL_BUDGET: Readonly<Record<LiteApiMode, number>> = {
  live: 2_000,
  sandbox: 1_000,
};

/** Bounded well inside the route's maxDuration (60 s) and a search's own latency. */
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
 * Resolves with the row on success so the caller can log usage.
 */
export async function takeLiteApiCall(
  mode: LiteApiMode,
  path: string,
  rpc: BudgetRpc = defaultRpc,
  limits: Readonly<Record<LiteApiMode, number>> = LITEAPI_DAILY_CALL_BUDGET
): Promise<BudgetTakeRow> {
  const limit = limits[mode];
  let result: Awaited<ReturnType<BudgetRpc>>;
  try {
    result = await bounded(rpc({ p_provider: "liteapi", p_mode: mode, p_limit: limit }), BUDGET_RPC_TIMEOUT_MS, "supplier_call_budget_take");
  } catch (err) {
    return refuseUnavailable(err instanceof Error ? err.message : String(err), mode, path);
  }
  if (result.error) {
    return refuseUnavailable(`rpc failed (${result.error.code ?? "?"}): ${result.error.message}`, mode, path);
  }
  const row = parseRow(result.data);
  if (!row) {
    return refuseUnavailable(`unexpected rpc result: ${JSON.stringify(result.data)?.slice(0, 200)}`, mode, path);
  }
  if (!row.allowed) {
    if (row.denied === 1) {
      captureAPIError(new Error(`LiteAPI daily call budget spent (${mode}, limit ${limit})`), {
        endpoint: "/api/park-stay/search",
        method: "GET",
        stage: "budget_exhausted",
        extra: { mode, limit, calls: row.calls, path },
      });
    }
    throw new LiteApiBudgetError("exhausted", `LiteAPI daily call budget spent (${mode}: ${row.calls}/${limit})`);
  }
  return row;
}

function refuseUnavailable(detail: string, mode: LiteApiMode, path: string): never {
  const err = new LiteApiBudgetError("unavailable", `LiteAPI call budget unavailable: ${detail}`);
  captureAPIError(err, {
    endpoint: "/api/park-stay/search",
    method: "GET",
    stage: "budget_unavailable",
    extra: { mode, path },
  });
  throw err;
}
