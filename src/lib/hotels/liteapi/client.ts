/**
 * LiteAPI HTTP client — the thin, typed fetch layer (reslab/client.ts
 * pattern). Everything above it (rates.ts, booking.ts) speaks in parsed JSON
 * and `LiteApiError`s; nothing above it touches `fetch`.
 *
 * - `X-API-Key` auth; the key comes from `resolveHotelEnv()` at call time,
 *   never at import.
 * - AbortController timeout that stays armed until the body is read (a stall
 *   mid-body is otherwise unbounded — the 2026-06-29 lesson).
 * - Two hosts: search/rates/prebook on `api.liteapi.travel`, book/get/cancel
 *   on `book.liteapi.travel`.
 * - `x-ratelimit-*` headers are surfaced on every result so callers can log
 *   them; a 429 is classified so the route can 503 + no-store rather than
 *   cache an empty "no hotels" body.
 * - Every request declares `meter`, so a new call site has to choose:
 *     "prepaid"   spends a `BudgetTicket` the caller already took (the Park &
 *                 Stay routes take ONE before any ResLab or LiteAPI call —
 *                 plan v3 §7.2). Never touches the budget table itself, so
 *                 there is no double take; the type makes the ticket
 *                 mandatory and the ticket refuses a second spend.
 *     "search"    takes one call from the durable daily budget (budget.ts)
 *                 BEFORE it is sent and throws LiteApiBudgetError when
 *                 refused — for any other metered caller.
 *     "unmetered" booking / cancel calls, which a search budget must never block.
 */

import { resolveHotelEnv } from "./env";
import { takeLiteApiCall, type BudgetTicket } from "./budget";

export const LITEAPI_TIMEOUT_MS = 10_000;

/**
 * The booking host (book / get / cancel on book.liteapi.travel) is OFF until
 * the reviewed Phase B launch PR flips this constant (plan §20.4). Production
 * holds the LIVE key from Phase A on (the admin preview prices real rooms), so
 * without this the first booking code merged to main could book real rooms
 * before B0's controls exist. A code constant, not an env var, on purpose.
 */
export const LITEAPI_BOOK_HOST_ENABLED = false;

export class LiteApiBookHostDisabledError extends Error {
  constructor(path: string) {
    super(`LiteAPI booking host is disabled in this phase (refused ${path})`);
    this.name = "LiteApiBookHostDisabledError";
  }
}

export type LiteApiHost = "data" | "book";

export class LiteApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public body?: unknown,
    /** LiteAPI's own numeric code when the body carries one (e.g. 2001 prebook conflict, 4005 duplicate). */
    public code?: number
  ) {
    super(message);
    this.name = "LiteApiError";
  }
  get isRateLimited(): boolean {
    return this.statusCode === 429;
  }
  /** Timeout / network / 5xx — the answer is unknown, not "no". */
  get isTransient(): boolean {
    return this.statusCode === 0 || this.statusCode === 408 || this.statusCode >= 500;
  }
}

export interface LiteApiRateLimit {
  limit: number | null;
  remaining: number | null;
}

export interface LiteApiResult {
  /** The parsed JSON body (or `{ raw }` for a non-JSON body) — UNTRUSTED: callers validate it. */
  data: unknown;
  rateLimit: LiteApiRateLimit;
  /** Wall time of the round-trip, for the Phase A latency measurement. */
  durationMs: number;
}

function readRateLimit(h: Headers): LiteApiRateLimit {
  const num = (v: string | null) => (v !== null && /^\d+$/.test(v) ? Number(v) : null);
  return { limit: num(h.get("x-ratelimit-limit")), remaining: num(h.get("x-ratelimit-remaining")) };
}

function extractCode(body: unknown): number | undefined {
  if (body && typeof body === "object") {
    const e = (body as { error?: { code?: unknown } }).error;
    if (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "number") {
      return (e as { code: number }).code;
    }
  }
  return undefined;
}

interface LiteApiRequestBase {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  timeoutMs?: number;
}

export type LiteApiRequestInit =
  | (LiteApiRequestBase & { meter: "prepaid"; ticket: BudgetTicket })
  | (LiteApiRequestBase & { meter: "search" | "unmetered" });

export async function liteApiRequest(
  host: LiteApiHost,
  path: string,
  init: LiteApiRequestInit
): Promise<LiteApiResult> {
  // Before the key, the meter and fetch: nothing is spent or sent.
  if (host === "book" && !LITEAPI_BOOK_HOST_ENABLED) throw new LiteApiBookHostDisabledError(path);
  const env = resolveHotelEnv();
  // Outside the try below: a refusal is a LiteApiBudgetError, never a LiteApiError.
  if (init.meter === "search") await takeLiteApiCall(env.mode, path);
  // A prepaid ticket was taken by the caller; spending it is the whole meter
  // (no second take). Throws — before anything is sent — on reuse or a mode
  // mismatch.
  else if (init.meter === "prepaid") init.ticket.spend(env.mode);
  const base = host === "data" ? env.dataBaseUrl : env.bookBaseUrl;
  const url = `${base}${path}`;
  const timeoutMs = init.timeoutMs ?? LITEAPI_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        "X-API-Key": env.apiKey,
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    if (!response.ok) {
      const msg =
        (parsed && typeof parsed === "object" && typeof (parsed as { error?: { description?: unknown } }).error?.description === "string"
          ? (parsed as { error: { description: string } }).error.description
          : `LiteAPI ${init.method ?? "GET"} ${path} failed (${response.status})`);
      throw new LiteApiError(response.status, msg, parsed, extractCode(parsed));
    }
    return { data: parsed, rateLimit: readRateLimit(response.headers), durationMs: Date.now() - started };
  } catch (err) {
    if (err instanceof LiteApiError) throw err;
    const isAbort = err instanceof Error && err.name === "AbortError";
    throw new LiteApiError(
      isAbort ? 408 : 0,
      isAbort ? `LiteAPI ${path} timed out after ${timeoutMs}ms` : `LiteAPI ${path} network error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
}
