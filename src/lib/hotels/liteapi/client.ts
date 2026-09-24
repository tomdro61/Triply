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
 */

import { resolveHotelEnv } from "./env";

export const LITEAPI_TIMEOUT_MS = 10_000;

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

export interface LiteApiResult<T> {
  data: T;
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

export async function liteApiRequest<T>(
  host: LiteApiHost,
  path: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown; timeoutMs?: number } = {}
): Promise<LiteApiResult<T>> {
  const env = resolveHotelEnv();
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
    return { data: parsed as T, rateLimit: readRateLimit(response.headers), durationMs: Date.now() - started };
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
